/* ------------------------------------------------------------------ *
 * Agent runtime state machine (closed-loop controller states).
 * UI-facing states (AgentStateKey) map back to the panel/robot surface.
 * Transitions are explicit — no uncontrolled jumps.
 * ------------------------------------------------------------------ */

import type { AgentStateKey } from "@/shared/types";

export type AgentRuntimeStatus =
  | "IDLE"
  | "UNDERSTANDING"
  | "OBSERVING"
  | "PLANNING"
  | "VALIDATING"
  | "ACTING"
  | "VERIFYING"
  | "ASK_USER"
  | "RECOVERY"
  | "COMPLETED"
  | "FAILED"
  | "PAUSED"
  | "WAITING_FOR_USER";

export const RUNTIME_TO_UI_STATUS: Record<AgentRuntimeStatus, AgentStateKey> = {
  IDLE: "IDLE",
  UNDERSTANDING: "THINKING",
  OBSERVING: "OBSERVING",
  PLANNING: "THINKING",
  VALIDATING: "THINKING",
  ACTING: "ACTING",
  VERIFYING: "THINKING",
  ASK_USER: "WAITING",
  RECOVERY: "THINKING",
  COMPLETED: "SUCCESS",
  FAILED: "ERROR",
  PAUSED: "PAUSED",
  WAITING_FOR_USER: "WAITING",
};

/** Explicit transition table for the runtime state machine. */
const ALLOWED: Readonly<Record<AgentRuntimeStatus, readonly AgentRuntimeStatus[]>> = {
  IDLE: ["UNDERSTANDING"],
  UNDERSTANDING: ["OBSERVING", "FAILED", "PAUSED"],
  OBSERVING: ["PLANNING", "COMPLETED", "FAILED", "PAUSED", "IDLE"],
  PLANNING: ["VALIDATING", "ASK_USER", "COMPLETED", "FAILED", "PAUSED"],
  VALIDATING: ["ACTING", "ASK_USER", "RECOVERY", "FAILED", "PAUSED"],
  ACTING: ["VERIFYING", "RECOVERY", "FAILED", "PAUSED"],
  VERIFYING: ["OBSERVING", "RECOVERY", "COMPLETED", "FAILED", "PAUSED"],
  RECOVERY: ["OBSERVING", "ASK_USER", "FAILED", "PAUSED", "IDLE"],
  ASK_USER: ["ACTING", "PLANNING", "FAILED", "PAUSED", "IDLE"],
  COMPLETED: ["IDLE", "PAUSED"],
  FAILED: ["IDLE"],
  PAUSED: ["UNDERSTANDING", "OBSERVING", "PLANNING", "VALIDATING", "ACTING", "VERIFYING", "RECOVERY", "ASK_USER", "IDLE"],
  WAITING_FOR_USER: ["OBSERVING", "PLANNING", "ACTING", "PAUSED", "IDLE", "FAILED"],
};

export class StateManager {
  private current: AgentRuntimeStatus = "IDLE";

  get status(): AgentRuntimeStatus {
    return this.current;
  }

  get ui(): AgentStateKey {
    return RUNTIME_TO_UI_STATUS[this.current];
  }

  /** Transition if allowed; returns true on success. */
  transition(next: AgentRuntimeStatus): boolean {
    const allowed = ALLOWED[this.current] ?? [];
    if (next === this.current) return true;
    if (!allowed.includes(next)) return false;
    this.current = next;
    return true;
  }

  force(next: AgentRuntimeStatus): void {
    this.current = next;
  }

  reset(): void {
    this.current = "IDLE";
  }

  isTerminal(): boolean {
    return this.current === "COMPLETED" || this.current === "FAILED";
  }
}