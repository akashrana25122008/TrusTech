/* ------------------------------------------------------------------ *
 * TaskMemory — ordered log of what the agent observed, planned,
 * executed and verified within a single task. Nothing leaves the
 * session; nothing is sent to an LLM verbatim.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";

export interface ObservationEntry {
  kind: "observation";
  snapshot: ObservationSnapshot;
  ts: number;
}

export interface PlannedEntry {
  kind: "planned";
  action: AgentAction;
  ts: number;
}

export interface ExecutedEntry {
  kind: "executed";
  action: AgentAction;
  ok: boolean;
  details?: string;
  ts: number;
}

export interface VerifiedEntry {
  kind: "verified";
  action: AgentAction;
  ok: boolean;
  evidence: string[];
  ts: number;
}

export interface ErrorEntry {
  kind: "error";
  message: string;
  ts: number;
}

export type MemoryEntry =
  | ObservationEntry
  | PlannedEntry
  | ExecutedEntry
  | VerifiedEntry
  | ErrorEntry;

export class TaskMemory {
  private entries: MemoryEntry[] = [];

  push(entry: MemoryEntry): void {
    this.entries.push(entry);
  }

  last(n = 1): MemoryEntry[] {
    return this.entries.slice(-n);
  }

  all(): readonly MemoryEntry[] {
    return this.entries;
  }

  actions(): AgentAction[] {
    return this.entries.filter((e): e is PlannedEntry => e.kind === "planned").map((e) => e.action);
  }

  recentObservation(): ObservationSnapshot | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].kind === "observation") return (this.entries[i] as ObservationEntry).snapshot;
    }
    return null;
  }

  reset(): void {
    this.entries = [];
  }
}