/* ------------------------------------------------------------------ *
 * Typed agent event bus — the decoupling seam between the controller
 * and any consumer (side panel UI, debug console, telemetry).
 * ------------------------------------------------------------------ */

import type { AgentAction } from "./action-schema";
import type { ActionResult, ObservationSnapshot } from "./messages";
import type { PrivacyVerdict } from "@/privacy/firewall";
import type { AgentRuntimeStatus } from "@/agent/state-manager";
import type { PlanMeta, TaskData, TaskStep } from "./types";

export interface AgentEventMap {
  TASK_STARTED: { taskId: string; goal: string };
  TASK_PAUSED: Record<string, never>;
  TASK_RESUMED: Record<string, never>;
  TASK_COMPLETED: { result?: string };
  TASK_FAILED: { reason: string };
  STATUS_CHANGED: { status: AgentRuntimeStatus };
  OBSERVATION_STARTED: Record<string, never>;
  OBSERVATION_UPDATED: { snapshot: ObservationSnapshot; freshness: "live" | "stale" };
  PLAN_CREATED: { action: AgentAction };
  /**
   * The task plan changed (first plan from the provider, or a re-plan that
   * replaced remaining steps). The UI mirrors `steps` verbatim — the
   * controller is the single writer of the Action Timeline.
   */
  PLAN_CHANGED: { steps: TaskStep[]; meta: PlanMeta; data?: TaskData | null };
  ACTION_PROPOSED: { action: AgentAction };
  ACTION_VALIDATED: { action: AgentAction; ok: boolean; reasons: string[] };
  ACTION_STARTED: { action: AgentAction };
  ACTION_SUCCEEDED: { action: AgentAction; hint?: ActionResult["hint"] };
  ACTION_FAILED: { action: AgentAction; error: string; details?: string };
  TAB_CREATED: { tabId: number; purpose?: string };
  TAB_SWITCHED: { tabId: number };
  TAB_CLOSED: { tabId: number };
  /** The agent's working tab changed mid-task (multi-tab follow). */
  TAB_CHANGED: { tabId: number; previous: number };
  /** Working tab is browser-internal: page controls unavailable, browser control still live. */
  PAGE_NOT_CONTROLLABLE: { url: string; tabId: number };
  VERIFICATION_STARTED: { action: AgentAction };
  VERIFICATION_SUCCEEDED: { action: AgentAction; evidence: string[] };
  VERIFICATION_FAILED: { action: AgentAction; evidence: string[] };
  USER_INPUT_REQUIRED: {
    reason: string;
    confirmable: boolean;
    /** Canonical action instance awaiting approval (absent on legacy flows). */
    actionId?: string;
    /** Value-free label: action name + target label (never typed text/URLs). */
    actionLabel?: string;
    riskLevel?: string;
    confidence?: number;
  };
  RECOVERY_ATTEMPT: { attempt: number; reason: string; strategy: string };
  PRIVACY_SCAN: { verdict: PrivacyVerdict; redacted: number };
  /**
   * The reasoning provider failed and the loop continues on the local
   * deterministic planner. Informational: the failure category is
   * preserved (never collapsed into a page error), execution continues.
   * `code`/`retryable` carry the provider failure taxonomy when known.
   */
  PROVIDER_FALLBACK: {
    provider: string;
    stage: "unavailable" | "request" | "empty" | "aborted";
    error?: string;
    code?: string;
    retryable?: boolean;
  };
  /**
   * The pre-network firewall authorized one outbound transmission.
   * Metadata only (decision, reason, categories, counts) — never values.
   */
  FIREWALL_DECISION: {
    provider: string;
    decision: "ALLOW" | "BLOCK";
    reason: string;
    detectedTypes: string[];
    redactionCount: number;
  };
  /**
   * The centralized safety gate decided an action's fate. Metadata only
   * (ids, decision, scores, reasons) — never values.
   */
  SAFETY_DECIDED: {
    actionId: string;
    decision: "AUTO_EXECUTE" | "LOCAL_VERIFY" | "USER_CONFIRMATION_REQUIRED" | "BLOCK" | "REPLAN";
    confidence: number;
    risk: string;
    target: string;
    reasons: string[];
  };
  /**
   * An approval arrived too late: the page or target changed since the
   * user was asked. The action must re-verify, never execute stale.
   */
  APPROVAL_INVALIDATED: { actionId: string; reason: string };
  /**
   * Feature #4 intent-drift finding. Metadata only (ids, scores, types,
   * generic reasons) — never values, never page text.
   */
  DRIFT_EVENT: {
    eventId: string;
    taskId: string;
    phase: "pre" | "post" | "completion";
    decision: "CONTINUE" | "VERIFY" | "PAUSE" | "REPLAN" | "ABORT";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    driftScore: number;
    driftTypes: string[];
    reasons: string[];
  };
  /**
   * Feature #6 trust assessment. Metadata only (ids, score, level,
   * decision, reason codes) — never values, never page text.
   */
  TRUST_EVENT: {
    eventId: string;
    taskId: string;
    score: number;
    level: "VERY_HIGH" | "HIGH" | "CAUTION" | "LOW" | "CRITICAL";
    decision: "CONTINUE" | "VERIFY" | "WARN" | "PAUSE" | "BLOCK";
    signals: string[];
    reasons: string[];
  };
}

type Handler<K extends keyof AgentEventMap> = (payload: AgentEventMap[K]) => void;

export class AgentEventBus {
  private handlers: Map<keyof AgentEventMap, Set<Handler<keyof AgentEventMap>>> = new Map();

  on<K extends keyof AgentEventMap>(event: K, cb: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb as Handler<keyof AgentEventMap>);
    return () => set.delete(cb as Handler<keyof AgentEventMap>);
  }

  emit<K extends keyof AgentEventMap>(event: K, payload: AgentEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        (cb as Handler<K>)(payload);
      } catch {
        /* a consumer crashing must never break the loop */
      }
    }
  }

  /** Latest snapshot of a state that interests the UI (mouse-over last event). */
  emitSync = this.emit;

  clear(): void {
    this.handlers.clear();
  }
}