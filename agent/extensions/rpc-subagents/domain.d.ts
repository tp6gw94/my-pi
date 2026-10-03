import type { Capabilities, CoordinationReport, CoordinationRequest } from "./coordination.d.ts";
export type { Capabilities, CoordinationReport, CoordinationRequest } from "./coordination.d.ts";

export type ModelSelection = { provider: string; id: string };
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type TaskSpec = {
  prompt: string;
  name: string;
  cwd: string;
  model: ModelSelection;
  thinking: ThinkingLevel;
  tools: string[];
  webAccess: boolean;
  async: boolean;
  timeoutMs: number;
} & (
  | { context: "fresh" | "fork"; session?: never }
  | { session: string; context?: never }
);
export type TaskDefaults = { cwd?: string; model?: ModelSelection; thinking?: ThinkingLevel; timeoutMs?: number };
export type Dialog = {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt: number;
};
export type TaskState = (
  | { status: "queued" }
  | { status: "starting" }
  | { status: "running"; disposition: "started" | "queued" }
  | { status: "waiting_input"; dialogs: Dialog[]; requests?: CoordinationRequest[] }
  | { status: "cancelling"; outcome: "cancelled" | "interrupted" | "failed"; reason: string }
  | { status: "completed"; disposition?: "handled" }
  | { status: "failed"; error: string }
  | { status: "cancelled"; reason: string }
  | { status: "interrupted"; reason: string }
) & { cleanupError?: string };
export type TaskResult = {
  taskId: string;
  name: string;
  model: ModelSelection;
  thinking?: ThinkingLevel;
  webAccess?: boolean;
  timeoutMs?: number;
  cwd: string;
  status: TaskState["status"];
  state: TaskState;
  text: string;
  truncated: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  currentTools: string[];
  eventFile: string;
  sessionFile?: string;
  sessionId?: string;
  sessionReusable?: boolean;
  continuedFromTaskId?: string;
  capabilities?: Capabilities;
  reports?: CoordinationReport[];
  requests?: CoordinationRequest[];
  droppedReportsThrough?: number;
  scheduleId?: string;
  ownerId: string;
  ownerPid: number;
  error?: string;
  persistenceError?: string;
};
export type BranchTemplate = {
  version: 1;
  parentSession?: string;
  entries: Record<string, unknown>[];
  droppedEntries: number;
};
export type Trigger =
  | { type: "at"; at: number }
  | { type: "interval"; intervalMs: number; anchor: number }
  | { type: "cron"; expression: string; timezone: string };
export type ScheduleState =
  | { status: "active" }
  | { status: "paused" }
  | { status: "cancelled" }
  | { status: "completed" }
  | { status: "missed" };
export type ScheduleRecord = {
  scheduleId: string;
  name: string;
  cwd: string;
  task: TaskSpec;
  trigger: Trigger;
  state: ScheduleState;
  revision: number;
  createdAt: number;
  nextAt: number | null;
  templatePath?: string;
  activeTaskIds: string[];
  history: { taskId?: string; at: number; status: string; error?: string }[];
  error?: string;
};
export type FleetRecord = {
  version: 1;
  seq: number;
  at: number;
  taskId: string;
  source: "fleet" | "rpc" | "stderr";
  event: Record<string, unknown>;
};

export const terminalTaskStates: Set<TaskState["status"]>;
export const terminalScheduleStates: Set<ScheduleState["status"]>;
export function assertTransition(previous: TaskState["status"], next: TaskState["status"]): void;
export function boundedInteger(value: unknown, name: string, min: number, max: number): number;
export function nonempty(value: unknown, name: string, max?: number): string;
/** Resume omits context so normalizing an already normalized spec preserves the exclusion. */
export function normalizeTaskSpec(input: unknown, defaults?: TaskDefaults): TaskSpec;
export function normalizeTools(value?: unknown): string[];
export function normalizeSessionReference(value: unknown): string;
export function defer<T = unknown>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
export function abortError(reason?: unknown): Error;
export function textContent(content: unknown): string;
export function boundedText(text: unknown, limit?: number): { text: string; truncated: boolean };
