/* ------------------------------------------------------------------ *
 * LlmPlanner — async action planner backed by an LLM provider. When
 * the provider is unavailable or returns unparsable output the
 * deterministic planner is used as a safe fallback so the loop never
 * stalls. The controller accepts this function via the `planner` option
 * and does not need to know which backend is active.
 *
 * Plan provenance: the Groq plan (list of task steps) rides along on the
 * first decision (and any re-plan). Fallback plans are the task-sourced
 * steps labeled `local` with a fallback reason — never silently mixed.
 * ------------------------------------------------------------------ */

import type { GatewayErrorCode, LlmProvider, LlmResponse } from "@/llm/llm-client";
import type { ObservationSnapshot } from "@/shared/messages";
import { taskStepsFrom, type TaskGoal, type PlannerPlan } from "./types";
import type { PlannerAction } from "./deterministic-planner";
import { planNextAction } from "./deterministic-planner";
import { buildPrompt } from "@/llm/prompt-builder";

/**
 * Optional contextual data from the controller memory (execution history
 * and latest verification evidence).
 */
export interface PlannerContext {
  history?: string[];
  verification?: Record<string, unknown> | null;
  /**
   * Called whenever the provider cannot deliver and the deterministic
   * fallback takes over, so the failure category is preserved in the
   * task record instead of vanishing into a silent fallback.
   */
  onProviderError?: (info: {
    provider: string;
    stage: "unavailable" | "request" | "empty" | "aborted";
    error?: string;
    code?: GatewayErrorCode;
    retryable?: boolean;
  }) => void;
  /**
   * Called when the pre-network firewall authorizes a request (value-free
   * metadata only) so the task record shows what was redacted/validated.
   */
  onFirewallAllow?: (info: {
    provider: string;
    reason: string;
    detectedTypes: string[];
    redactionCount: number;
  }) => void;
  /** Called when the firewall BLOCKS a transmission (metadata only). */
  onFirewallBlock?: (info: {
    provider: string;
    reason: string;
    detectedTypes: string[];
  }) => void;
}

/**
 * The unified planner signature the controller consumes. May return
 * synchronously (deterministic) or asynchronously (LLM).
 */
export type ActionPlanner = (
  goal: TaskGoal,
  stepIndex: number,
  snapshot: ObservationSnapshot,
  context?: PlannerContext,
) => PlannerAction | null | Promise<PlannerAction | null>;

/** Fall back to the deterministic planner (local task-sourced plan). */
function det(
  goal: TaskGoal,
  stepIndex: number,
  snapshot: ObservationSnapshot,
  fallbackReason?: string,
): PlannerAction | null {
  const decision = planNextAction(goal, stepIndex, snapshot);
  if (decision && stepIndex === 0) {
    decision.plan = {
      steps: taskStepsFrom(goal.steps),
      source: "local",
      fallbackReason,
    };
  }
  return decision;
}

/** Local plan used when the provider answered but sent no structured plan. */
function noPlanFallback(goal: TaskGoal, fallbackReason: string): PlannerPlan {
  return { steps: taskStepsFrom(goal.steps), source: "local", fallbackReason };
}

/**
 * Build an `ActionPlanner` that calls the LLM first. The `historyHint`
 * parameter is passed through to the prompt builder so the model can
 * factor in the observation history (the caller builds this string).
 */
export function buildLlmPlanner(
  provider: LlmProvider,
  historyHint: string = "",
): ActionPlanner {
  return async (
    goal: TaskGoal,
    stepIndex: number,
    snapshot: ObservationSnapshot,
    context?: PlannerContext,
  ): Promise<PlannerAction | null> => {
    if (!(await provider.available())) {
      // The health probe measures the LOCAL gateway process, never Groq.
      // Say exactly that (plus the classified probe outcome) so a stopped
      // backend is never misread as "Groq is down".
      const health =
        (provider as { lastHealthError?: string | null }).lastHealthError ?? undefined;
      const reason = health
        ? `reasoning gateway unreachable (${health}); local task-sourced plan used`
        : `reasoning provider "${provider.name}" unavailable; local task-sourced plan used`;
      context?.onProviderError?.(
        health
          ? { provider: provider.name, stage: "unavailable", error: health }
          : { provider: provider.name, stage: "unavailable" },
      );
      return det(goal, stepIndex, snapshot, reason);
    }

    try {
      const history = context?.history ?? (historyHint ? [historyHint] : []);
      const verification = context?.verification ?? null;
      const historyStr = history.length > 0 ? history.join("\n") : historyHint;
      const { systemPrompt, userPrompt } = buildPrompt(goal.goal, goal.intent, snapshot, historyStr);

      const response: LlmResponse = await provider.complete({
        systemPrompt,
        userPrompt,
        stepContext: {
          task: { goal: goal.goal, intent: goal.intent },
          observation: snapshot,
          history,
          verification,
        },
      });

      // Surface the pre-network firewall verdict (metadata only, never
      // values) so the task record shows each transmission was gated.
      if (response.firewall?.decision === "ALLOW") {
        context?.onFirewallAllow?.({
          provider: provider.name,
          reason: response.firewall.reason,
          detectedTypes: response.firewall.detectedTypes,
          redactionCount: response.firewall.redactionCount,
        });
      }

      if (!response.ok || !response.actions || response.actions.length === 0) {
        const errText = response.error ?? "error";
        if (response.firewall?.decision === "BLOCK") {
          context?.onFirewallBlock?.({
            provider: provider.name,
            reason: response.firewall.reason,
            detectedTypes: response.firewall.detectedTypes,
          });
        }
        // An aborted request (task stopped/superseded) is a lifecycle
        // event, not a provider outage — never label it as one.
        if (errText === "aborted" || response.errorCode === "ABORTED") {
          const reason = `reasoning request aborted; local task-sourced plan used`;
          context?.onProviderError?.({
            provider: provider.name,
            stage: "aborted",
            error: errText,
            code: "ABORTED",
            retryable: false,
          });
          return det(goal, stepIndex, snapshot, reason);
        }
        const code = response.errorCode;
        const retryable = response.retryable;
        const suffix = code ? ` [${code}${retryable ? ", retryable" : ""}]` : "";
        const reason = response.ok
          ? `reasoning provider returned no action; local task-sourced plan used`
          : `reasoning provider failed (${errText})${suffix}; local task-sourced plan used`;
        context?.onProviderError?.({
          provider: provider.name,
          stage: response.ok ? "empty" : "request",
          error: response.error,
          ...(code ? { code, retryable } : {}),
        });
        return det(goal, stepIndex, snapshot, reason);
      }

      // Take the first action the model proposed.
      const action = response.actions[0];
      const decision: PlannerAction = {
        action,
        justification: `LLM (${provider.name}): ${response.raw?.slice(0, 120) ?? "structured"}`,
      };
      if (response.plan && response.plan.length > 0) {
        // Groq plan: the reasoner's own task steps drive the timeline.
        decision.plan = { steps: response.plan, source: "groq", data: response.data };
      } else if (stepIndex === 0) {
        decision.plan = noPlanFallback(goal, "reasoning provider returned no structured plan; using task-sourced steps");
      }
      return decision;
    } catch (err) {
      // Provider crashed — deterministic fallback keeps the loop alive.
      const reason = `reasoning provider crashed (${err instanceof Error ? err.message : String(err)}); local task-sourced plan used`;
      context?.onProviderError?.({
        provider: provider.name,
        stage: "request",
        error: err instanceof Error ? err.message : String(err),
      });
      return det(goal, stepIndex, snapshot, reason);
    }
  };
}
