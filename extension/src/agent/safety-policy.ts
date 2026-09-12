/* ------------------------------------------------------------------ *
 * SafetyPolicy — the ONE authoritative pre-execution decision point.
 *
 *   CONFIDENCE ≠ PERMISSION. The model proposes; this local, deterministic
 *   policy disposes. Risk always overrides confidence; hard overrides
 *   (unknown/ambiguous/stale targets, critical risk) can never be
 *   bypassed by a high model score.
 *
 * Decision matrix (confidence × risk):
 *
 *                LOW      MEDIUM     HIGH      CRITICAL
 *   HIGH         AUTO     VERIFY     CONFIRM   CONFIRM
 *   MEDIUM       VERIFY   VERIFY     CONFIRM   CONFIRM
 *   LOW          VERIFY   CONFIRM    BLOCK     BLOCK
 *
 * Fail closed: anything unrecognized → BLOCK/REPLAN, never execute.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { RiskLevel } from "./risk-manager";
import type { TargetStatus, TargetVerification } from "./target-verifier";

export type SafetyDecisionKind =
  | "AUTO_EXECUTE"
  | "LOCAL_VERIFY"
  | "USER_CONFIRMATION_REQUIRED"
  | "BLOCK"
  | "REPLAN";

export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

/** Centralized thresholds — the ONLY numeric safety thresholds. */
export const SAFETY_THRESHOLDS = {
  /** >= high → HIGH band (auto-execution candidate for LOW risk). */
  high: 0.85,
  /** >= medium → MEDIUM band; below → LOW band (never blind). */
  medium: 0.6,
} as const;

/** Confidence weights — independent evidence, never the model alone. */
const WEIGHTS = { model: 0.25, target: 0.3, context: 0.2, validity: 0.15, intent: 0.1 } as const;

export interface ConfidenceComponents {
  /** Model-proposed score, discounted when missing/invalid. */
  model: number;
  /** Target verification contribution. */
  target: number;
  /** Page-context freshness contribution. */
  context: number;
  /** Parameter/shape validity contribution. */
  validity: number;
  /** Task-intent consistency contribution. */
  intent: number;
}

export interface ConfidenceBreakdown {
  final: number;
  band: ConfidenceBand;
  components: ConfidenceComponents;
  reason: string;
}

/** Canonical action instance — every decision binds to one of these. */
export interface CanonicalAction {
  actionId: string;
  taskId: string;
  action: AgentAction;
  /** Model-proposed confidence as received (may be absent/invalid). */
  proposedConfidence?: number;
  /** Goal text for intent-consistency scoring (never transmitted). */
  goal: string;
  /** Page URL at plan time (staleness anchor). */
  plannedUrl: string;
}

export interface SafetyEvaluation {
  decision: SafetyDecisionKind;
  confidence: ConfidenceBreakdown;
  risk: RiskLevel;
  target: TargetVerification;
  /** Human-readable, value-free reasons (safe for UI + logs). */
  reasons: string[];
  actionId: string;
}

export interface SafetyInput {
  canonical: CanonicalAction;
  risk: RiskLevel;
  riskRequiresConfirmation: boolean;
  target: TargetVerification;
  /** Structural validation passed (validator ok). */
  validityOk: boolean;
  /** Page still matches what planning saw (no drift). */
  contextFresh: boolean;
  /**
   * Whether the page exposes a DOM bridge at all. When false there is
   * nothing to verify against: browser-level actions proceed (the old
   * bootstrap path), and an absent target replans instead of blocking
   * (absence is unknowable without observation).
   */
  verifiable: boolean;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function bandOf(final: number): ConfidenceBand {
  if (final >= SAFETY_THRESHOLDS.high) return "HIGH";
  if (final >= SAFETY_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

/** Intent consistency: goal-token overlap with what the action touches. */
function intentScore(goal: string, action: AgentAction): number {
  const tokens = goal.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0.6;
  const haystack = [action.target?.name ?? "", action.text ?? "", action.url ?? "", action.action]
    .join(" ")
    .toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  if (hits >= 2) return 0.9;
  if (hits === 1) return 0.75;
  // Navigation/task-level actions carry intent structurally, not lexically.
  if (["navigate", "new_tab", "finish", "ask_user", "wait", "reload"].includes(action.action)) return 0.8;
  return 0.6;
}

/**
 * Independently computed confidence. The model score is ONE input at
 * 25% weight; missing/invalid model scores are discounted, never fatal
 * on their own — other evidence still counts.
 */
export function computeConfidence(
  proposed: number | undefined,
  target: TargetVerification,
  contextFresh: boolean,
  validityOk: boolean,
  goal: string,
  action: AgentAction,
): ConfidenceBreakdown {
  const notes: string[] = [];
  let model: number;
  if (typeof proposed === "number" && Number.isFinite(proposed)) {
    model = clamp01(proposed);
  } else {
    model = 0.4;
    notes.push("model confidence missing/invalid — discounted");
  }
  const context = contextFresh ? 0.9 : 0.3;
  if (!contextFresh) notes.push("page context changed since planning");
  const validity = validityOk ? 0.9 : 0.2;
  if (!validityOk) notes.push("structural validation failed");
  const intent = intentScore(goal, action);

  const final = Math.round(
    (model * WEIGHTS.model +
      target.confidence * WEIGHTS.target +
      context * WEIGHTS.context +
      validity * WEIGHTS.validity +
      intent * WEIGHTS.intent) *
      100,
  ) / 100;
  if (notes.length === 0) notes.push("model, target, context, validity and intent agree");
  return { final, band: bandOf(final), components: { model, target: target.confidence, context, validity, intent }, reason: notes.join("; ") };
}

const MATRIX: Record<ConfidenceBand, Record<RiskLevel, SafetyDecisionKind>> = {
  HIGH: { LOW: "AUTO_EXECUTE", MEDIUM: "LOCAL_VERIFY", HIGH: "USER_CONFIRMATION_REQUIRED", CRITICAL: "USER_CONFIRMATION_REQUIRED" },
  MEDIUM: { LOW: "LOCAL_VERIFY", MEDIUM: "LOCAL_VERIFY", HIGH: "USER_CONFIRMATION_REQUIRED", CRITICAL: "USER_CONFIRMATION_REQUIRED" },
  LOW: { LOW: "LOCAL_VERIFY", MEDIUM: "USER_CONFIRMATION_REQUIRED", HIGH: "BLOCK", CRITICAL: "BLOCK" },
};

/**
 * The single safety decision function. Pure + deterministic.
 *
 * Hard overrides (model confidence can never bypass):
 * - missing/unknown target → BLOCK
 * - ambiguous target → LOCAL_VERIFY (LOW/MEDIUM) or CONFIRM (HIGH/CRITICAL)
 * - stale target or changed page → REPLAN
 * - hidden/disabled/label-mismatch → REPLAN (re-observe may rescue)
 * - risk flag requiresConfirmation floors the decision at CONFIRM
 */
export function evaluateActionSafety(input: SafetyInput): SafetyEvaluation {
  const { canonical, risk, target } = input;
  const reasons: string[] = [];

  const confidence = computeConfidence(
    canonical.proposedConfidence,
    target,
    input.contextFresh,
    input.validityOk,
    canonical.goal,
    canonical.action,
  );

  // — hard overrides —
  if (target.status === "missing") {
    // Without a DOM bridge absence proves nothing — recovery (usually
    // navigation to a scriptable page) may rescue it.
    if (!input.verifiable) {
      return decided("REPLAN", confidence, risk, target, canonical.actionId, [
        ...reasons, `target not observable on this page (${target.reason}) — re-observe may rescue`,
      ]);
    }
    return decided("BLOCK", confidence, risk, target, canonical.actionId, [
      ...reasons, `unknown target — refusing to execute blind (${target.reason})`,
    ]);
  }
  if (target.status === "stale") {
    return decided("REPLAN", confidence, risk, target, canonical.actionId, [
      ...reasons, `stale action — page changed (${target.reason})`,
    ]);
  }
  if (target.status === "ambiguous") {
    const decision = risk === "LOW" || risk === "MEDIUM" ? "LOCAL_VERIFY" : "USER_CONFIRMATION_REQUIRED";
    return decided(decision, confidence, risk, target, canonical.actionId, [
      ...reasons, `${target.matches} matching targets — will not pick arbitrarily (${target.reason})`,
    ]);
  }
  if (target.status === "hidden" || target.status === "disabled" || target.status === "label_mismatch") {
    // Consequential actions with a shifted target escalate to the human
    // (who can see the discrepancy); routine ones re-observe and replan.
    if (target.status === "label_mismatch" && (risk === "HIGH" || risk === "CRITICAL")) {
      return decided("USER_CONFIRMATION_REQUIRED", confidence, risk, target, canonical.actionId, [
        ...reasons, `target label no longer matches — human must resolve (${target.reason})`,
      ]);
    }
    return decided("REPLAN", confidence, risk, target, canonical.actionId, [
      ...reasons, `target not actionable (${target.reason}) — re-observe may rescue`,
    ]);
  }

  // — matrix —
  let decision = MATRIX[confidence.band][risk];
  reasons.push(`confidence ${confidence.band} (${confidence.final}) × risk ${risk} → ${decision}`);
  // No DOM bridge means LOCAL_VERIFY is vacuous: browser-level actions
  // are verification-exempt (the bootstrap path), page-level absence
  // already diverted to REPLAN/BLOCK above.
  if (!input.verifiable && decision === "LOCAL_VERIFY") {
    decision = "AUTO_EXECUTE";
    reasons.push("no DOM bridge — verification-exempt browser action proceeds");
  }
  // A planner/risk confirmation flag can only escalate, never relax.
  if (input.riskRequiresConfirmation && (decision === "AUTO_EXECUTE" || decision === "LOCAL_VERIFY")) {
    decision = "USER_CONFIRMATION_REQUIRED";
    reasons.push("risk gate requires confirmation — escalated");
  }
  return decided(decision, confidence, risk, target, canonical.actionId, reasons);
}

function decided(
  decision: SafetyDecisionKind,
  confidence: ConfidenceBreakdown,
  risk: RiskLevel,
  target: TargetVerification,
  actionId: string,
  reasons: string[],
): SafetyEvaluation {
  return { decision, confidence, risk, target, reasons, actionId };
}

/** Target statuses no automation may ever execute against. */
export function isHardStopTarget(status: TargetStatus): boolean {
  return status === "missing" || status === "stale";
}
