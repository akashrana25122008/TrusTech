/* ------------------------------------------------------------------ *
 * LLM boundary — the ONLY seam to a remote reasoning model. All
 * outbound traffic goes through the PrivacyFirewall first; all inbound
 * output arrives as structured JSON that must survive schema
 * validation before any action is planned.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import type { TaskData, TaskStep } from "@/shared/types";

export interface StepContext {
  task: { goal: string; intent?: string };
  observation: ObservationSnapshot;
  history?: string[];
  verification?: Record<string, unknown> | null;
}

export interface LlmRequest {
  systemPrompt?: string;
  userPrompt?: string;
  /** Max output tokens — keeps model-spew out. */
  maxTokens?: number;
  /** Structured step context for gateway-backed providers. */
  stepContext?: StepContext;
}

export interface LlmResponse {
  ok: boolean;
  /** Raw model output (may be wrapped in code fences). */
  raw?: string;
  /** Structured actions (post-parse). */
  actions?: AgentAction[];
  /** Structured task plan from the provider (pending steps drive the timeline). */
  plan?: TaskStep[];
  /** Task data delivered alongside the plan (user-provided inputs, generated sample data, interpretation). */
  data?: TaskData;
  error?: string;
  /**
   * Machine-readable failure class for `error` (gateway-shaped failures
   * only). Lets the planner preserve the category instead of collapsing
   * everything into "unavailable".
   */
  errorCode?: GatewayErrorCode;
  /** Whether retrying the same request could plausibly succeed. */
  retryable?: boolean;
  /**
   * Local firewall metadata for this request (value-free: decision,
   * reason, categories, counts). Present on every gateway attempt.
   */
  firewall?: {
    decision: "ALLOW" | "BLOCK";
    reason: string;
    detectedTypes: string[];
    redactionCount: number;
  };
}

/**
 * Provider failure taxonomy. Every gateway failure maps to one of these;
 * nothing is ever reported as a bare "unavailable" without a cause.
 */
export type GatewayErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "CONFIG"
  | "AUTH"
  | "RATE_LIMITED"
  | "RESPONSE_PARSE"
  | "PROVIDER"
  | "BAD_REQUEST"
  | "POLICY_BLOCK"
  | "UNKNOWN";

export interface LlmProvider {
  readonly name: string;
  available(): Promise<boolean>;
  complete(prompt: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/**
 * Local-only placeholder provider. Reports unavailable and returns a
 * deterministic fallback so the boundary is safe to wire early without
 * rejecting the rest of the runtime.
 */
export class NoopLlmProvider implements LlmProvider {
  readonly name = "noop";

  async available(): Promise<boolean> {
    return false;
  }

  async complete(): Promise<LlmResponse> {
    return { ok: false, error: "no_llm_provider_configured" };
  }
}

/** Shared header text the prompt builder includes in every user turn. */
export const LLM_GUARDRAILS = [
  "Only output one JSON object — no prose, no markdown.",
  "Use ONLY the actions and element ids in the system schema.",
  "Never invent element ids; use ids from the observation, or navigate first.",
  "Never read a page twice unnecessarily; prefer the freshest observation.",
  "End with a finish action when the task is complete.",
].join("\n");

export { GatewayLlmProvider } from "./gateway-provider";