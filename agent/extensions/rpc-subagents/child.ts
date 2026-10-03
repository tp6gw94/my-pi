import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AskClosedReason, LaunchBinding, NormalizedParentCall, ParentCallResult, ToolExposure, ToolInventory } from "./coordination.d.ts";
import {
  BOOTSTRAP_COMMAND_NAME, COORDINATION_LIMITS, PARENT_TOOL_NAME,
  createCoordinationRequestId, encodeCoordinationEnvelope, normalizeParentCall,
} from "./coordination.mjs";
import { CHILD_BINDING_ENV, WEB_INVENTORY_EVENT, WEB_SOURCE_ENV } from "./runtime.mjs";

const parentParameters = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["ask", "report"] },
    question: { type: "string", minLength: 1, maxLength: COORDINATION_LIMITS.maxTextChars },
    message: { type: "string", minLength: 1, maxLength: COORDINATION_LIMITS.maxTextChars },
    timeoutMs: { type: "integer", minimum: COORDINATION_LIMITS.minAskTimeoutMs, maximum: COORDINATION_LIMITS.maxAskTimeoutMs },
  },
} as unknown as TSchema;

const ASK_PLACEHOLDER = "Answer for the blocked child task";

type ChildLaunch = { binding: LaunchBinding; asynchronous: boolean };

function identity(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= COORDINATION_LIMITS.maxIdentityChars && !value.includes("\0");
}

export function readLaunchBinding(env: Record<string, string | undefined>): ChildLaunch | undefined {
  if (env[CHILD_BINDING_ENV.flag] !== "1") return undefined;
  const async = env[CHILD_BINDING_ENV.async];
  if (async !== "0" && async !== "1") return undefined;
  const taskId = env[CHILD_BINDING_ENV.taskId];
  const ownerId = env[CHILD_BINDING_ENV.ownerId];
  const nonce = env[CHILD_BINDING_ENV.nonce];
  if (!identity(taskId) || !identity(ownerId) || !identity(nonce)) return undefined;
  return { binding: { taskId, ownerId, nonce }, asynchronous: async === "1" };
}

export function collectToolInventory(pi: ExtensionAPI): ToolInventory {
  const registered: string[] = [];
  const exposures: Record<string, ToolExposure> = {};
  for (const tool of pi.getAllTools()) {
    registered.push(tool.name);
    exposures[tool.name] = tool.exposure;
  }
  const active = [...pi.getActiveTools()];
  const activeSet = new Set(active);
  const metadata: { webTools?: string[] } = {};
  pi.events?.emit(WEB_INVENTORY_EVENT, metadata);
  return {
    ...metadata,
    registered,
    active,
    declared: [...active],
    callable: registered.filter((name) => exposures[name] === "codemode" || exposures[name] === "deferred"
      || (exposures[name] === "direct" && activeSet.has(name))),
    exposures,
  };
}

function toolResult(value: ParentCallResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

async function askParent(launch: ChildLaunch, call: { question: string; timeoutMs: number }, signal: AbortSignal | undefined, ctx: ExtensionToolContext) {
  const { binding } = launch;
  const requestId = createCoordinationRequestId();
  const expiresAt = Date.now() + call.timeoutMs;
  const envelope = encodeCoordinationEnvelope(binding, { kind: "ask", requestId, question: call.question, expiresAt });
  const controller = new AbortController();
  let aborted = signal?.aborted === true;
  const onAbort = () => { aborted = true; controller.abort(); };
  if (aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const remaining = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
  let value: string | undefined;
  let failed = false;
  try {
    value = await ctx.ui.input(envelope, ASK_PLACEHOLDER, { signal: controller.signal, timeout: remaining });
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const reason: AskClosedReason = value !== undefined ? "answered" : failed ? "failed" : aborted ? "aborted" : timedOut ? "timeout" : "cancelled";
  try { ctx.ui.notify(encodeCoordinationEnvelope(binding, { kind: "ask_closed", requestId, reason })); } catch {}
  return value === undefined ? toolResult({ status: "cancelled" }) : toolResult({ status: "answered", value });
}

export default function registerChildBridge(pi: ExtensionAPI, env: Record<string, string | undefined> = process.env): void {
  const launch = readLaunchBinding(env);
  if (!launch) return;
  pi.registerTool({
    name: PARENT_TOOL_NAME,
    label: "Parent coordination",
    description: "Ask the owning parent Pi session a question or send it a one-way report. kind=ask blocks this task until the parent answers or the ask is cancelled, timed out, or aborted; in a synchronous task it returns requires_async immediately. kind=report returns right after emitting the message. Neither kind takes a destination: the owning parent session always receives it.",
    parameters: parentParameters,
    exposure: "model-only",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const call = normalizeParentCall(params) as NormalizedParentCall;
      if (call.kind === "report") {
        const messageId = `msg-${randomUUID()}`;
        ctx.ui.notify(encodeCoordinationEnvelope(launch.binding, { kind: "report", messageId, message: call.message }));
        return toolResult({ status: "reported", messageId });
      }
      if (!launch.asynchronous) return toolResult({ status: "requires_async" });
      return askParent(launch, call, signal, ctx);
    },
  });
  let lastInventory: string | undefined;
  const emitInventory = (ctx: Pick<ExtensionToolContext, "ui">) => {
    const inventory = collectToolInventory(pi);
    const serialized = JSON.stringify(inventory);
    if (serialized === lastInventory) return;
    ctx.ui.notify(encodeCoordinationEnvelope(launch.binding, { kind: "inventory", inventory }));
    lastInventory = serialized;
  };
  if (env[WEB_SOURCE_ENV]) {
    const refresh = (_event: unknown, ctx: Pick<ExtensionToolContext, "ui">) => {
      if (lastInventory !== undefined) emitInventory(ctx);
    };
    pi.on("tool_result", refresh);
    pi.on("before_agent_start", refresh);
  }
  pi.registerCommand(BOOTSTRAP_COMMAND_NAME, {
    description: "Emit the versioned RPC subagents tool inventory without a model call.",
    handler: async (_args, ctx) => {
      emitInventory(ctx);
    },
  });
}
