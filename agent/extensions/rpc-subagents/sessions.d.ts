import type { ModelSelection, TaskState } from "./domain.d.ts";

export type SessionLease = Readonly<{
  kind: "fresh" | "resume";
  taskId: string;
  sessionFile: string;
  token: string;
  sessionId?: string;
  continuedFromTaskId?: string;
}>;
export type SessionOutcome = {
  sessionFile: string;
  sessionId?: string;
  continuedFromTaskId?: string;
  sessionReusable: boolean;
};
export type SessionAcquisition = {
  taskId: string;
  cwd: string;
  model: ModelSelection;
  signal?: AbortSignal;
};
export type SessionFinalization = {
  status: Extract<TaskState["status"], "completed" | "failed" | "cancelled" | "interrupted">;
  processClosed: boolean;
  cleanupError?: string;
  persistenceError?: string;
};

export class SessionRegistry {
  constructor(options: { root: string; ownerId: string; ownerPid?: number });
  acquireFresh(input: SessionAcquisition & { directory: string }): Promise<SessionLease>;
  acquireResume(input: SessionAcquisition & { session: string }): Promise<SessionLease>;
  attach(lease: SessionLease, child: { childPid: number }): Promise<void>;
  observe(lease: SessionLease, state: { sessionId: string; sessionFile: string; model: ModelSelection }): Promise<SessionLease>;
  finalize(lease: SessionLease, outcome: SessionFinalization): Promise<SessionOutcome>;
  release(lease: SessionLease, options?: { neverLaunched?: boolean }): Promise<SessionOutcome>;
}
