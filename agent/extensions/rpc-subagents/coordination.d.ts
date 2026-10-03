export const PARENT_TOOL_NAME: "rpc_subagents_parent";
export const BOOTSTRAP_COMMAND_NAME: "rpc-subagents-bootstrap";
export const BOOTSTRAP_PROMPT: "/rpc-subagents-bootstrap";
export const COORDINATION_PREFIX: "rpc-subagents-coordination:";
export const COORDINATION_VERSION: 1;
export const DEFAULT_EXECUTION_TOOLS: readonly ["read", "write", "edit", "bash", "codemode"];
export const COORDINATION_LIMITS: Readonly<{
  maxTools: 64;
  maxToolNameChars: 160;
  maxTextChars: 8192;
  maxAnswerChars: 65536;
  maxPendingRequests: 16;
  maxReports: 64;
  maxPendingLimit: 64;
  minAskTimeoutMs: 1000;
  maxAskTimeoutMs: 120000;
  defaultAskTimeoutMs: 120000;
  maxIdentityChars: 160;
  maxSessionReferenceChars: 4096;
  maxWebTools: 16;
  maxInventoryTools: 81;
  maxEnvelopeChars: 65536;
}>;

export type LaunchBinding = { taskId: string; ownerId: string; nonce: string };
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";
export type ToolInventory = {
  webTools?: string[];
  registered: string[];
  active: string[];
  declared: string[];
  callable: string[];
  exposures: Record<string, ToolExposure>;
};
export type Capabilities = ToolInventory & { requested: string[]; reachable: string[] };
export type ParentCall =
  | { kind: "ask"; question: string; timeoutMs?: number }
  | { kind: "report"; message: string };
export type NormalizedParentCall =
  | { kind: "ask"; question: string; timeoutMs: number }
  | { kind: "report"; message: string };
export type ParentAnswer = { value: string } | { cancelled: true };
export type ParentCallResult =
  | { status: "answered"; value: string }
  | { status: "cancelled" }
  | { status: "requires_async" }
  | { status: "reported"; messageId: string };
export type CoordinationRequest = { requestId: string; question: string; expiresAt: number };
export type CoordinationReport = { messageId: string; seq: number; at: number; message: string };
export type PendingOptions = { after?: number; limit?: number };
export type PendingCoordination = {
  requests: CoordinationRequest[];
  reports: CoordinationReport[];
  nextAfter: number;
  droppedThrough: number;
};
export type AskClosedReason = "answered" | "cancelled" | "timeout" | "aborted" | "failed";
export type CoordinationMessage =
  | { kind: "inventory"; inventory: ToolInventory }
  | ({ kind: "ask" } & CoordinationRequest)
  | { kind: "report"; messageId: string; message: string }
  | { kind: "ask_closed"; requestId: string; reason: AskClosedReason };
export type CoordinationEnvelope = LaunchBinding & { version: 1 } & CoordinationMessage;
export type ParsedCoordinationRecord =
  | { method: "input"; nativeDialogId: string; envelope: Extract<CoordinationEnvelope, { kind: "ask" }> }
  | { method: "notify"; envelope: Exclude<CoordinationEnvelope, { kind: "ask" }> };

/** Undefined uses the defaults. Custom arrays replace them, including an empty array. Duplicates reject. */
export function normalizeTools(value?: unknown): string[];
/** Accepts an opaque literal ID or an absolute .jsonl path without resolving or adopting it. */
export function normalizeSessionReference(value: unknown): string;
export function normalizeCoordinationText(value: unknown, name?: string): string;
export function normalizeParentCall(value: unknown): NormalizedParentCall;
export function normalizeParentAnswer(value: unknown): ParentAnswer;
export function normalizePendingOptions(value?: unknown): { after: number; limit: number };
/** The ask- namespace distinguishes coordination request IDs from native UUID dialog IDs. */
export function createCoordinationRequestId(): string;
export function encodeCoordinationEnvelope(binding: LaunchBinding, message: CoordinationMessage): string;
/** Ordinary text and unrelated version/kind/binding return null. Malformed prefixed JSON or matching payloads throw. */
export function decodeCoordinationEnvelope(value: unknown, binding: LaunchBinding): CoordinationEnvelope | null;
/** Notify carries inventory/report/ask_closed in message. Input carries ask in title. Other methods stay ordinary. */
export function parseCoordinationRecord(record: unknown, binding: LaunchBinding): ParsedCoordinationRecord | null;
/** Validates bounded names, complete exposure metadata, and actual active/declared/callable consistency. */
export function validateToolInventory(value: unknown): ToolInventory;
/** Requires declared union callable to equal requested union the model-only parent tool. Reachable is sorted. */
export function verifyCapabilities(requested: unknown, inventory: unknown, webAccess?: boolean, approvedWebTools?: string[]): Capabilities;
