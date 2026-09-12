/* ------------------------------------------------------------------ *
 * Agent simulator — deterministic stand-in for the closed-loop runtime
 * when run outside a real extension (vite dev). Every event is a list
 * the UI reducer applies on a timeline; swapping to the live
 * AgentController only requires re-plumbing the feed.
 * ------------------------------------------------------------------ */

import { planFor, type SimEvent, type AgentPlan } from "@/agent/planner";
import { detectPii } from "@/privacy/detector";

export type { SimEvent } from "@/agent/planner";

export interface HoldInfo {
  level: "low" | "medium" | "high";
  label: string;
  reasons: string[];
  type: "confirm" | "info";
}

export interface GuardedStep {
  event: SimEvent;
  hold?: HoldInfo;
}

export interface GuardedTimeline {
  runNow: GuardedStep[];
  deferred: GuardedStep[];
  gate?: GuardedStep;
  labels: string[];
  privacy: { redactedFields: number };
}

/** Simulated page snippet that the privacy firewall would scan in a live page. */
function simulatedPageContext(task: string): string {
  return [
    "Welcome back. your@email.com +919876543210",
    "Contact us at support@example.com or call 080-1234-5678.",
    `Task page snippet: ${task}.`,
  ].join(" ");
}

export function buildGuardedTimeline(task: string): GuardedTimeline {
  const plan: AgentPlan = planFor(task);

  const matches = detectPii(simulatedPageContext(task));
  const redactedFields = matches.length;

  const isFinancial = /buy|purchase|payment|pay|cart|checkout|book|ticket|train|flight|₹|transaction|irctc|payment gateway|donate|order|subscribe/.test(task.toLowerCase());
  const level: HoldInfo["level"] = isFinancial ? "high" : "low";
  const gateLabel = isFinancial ? "Financial confirmation" : "Final review";

  const steps: GuardedStep[] = plan.events.map((event) => ({ event }));
  const gate = steps[steps.length - 1];
  const runNow = steps.slice(0, -1);

  gate.hold = {
    level,
    label: gateLabel,
    reasons: isFinancial
      ? ["High-risk: this task can debit money or commit an order.", "Verifying a dry/read-only step before anything irreversible."]
      : ["Final review step — let the user confirm the agent did the right thing."],
    type: "confirm",
  };

  return {
    runNow,
    deferred: [gate],
    gate,
    labels: plan.steps,
    privacy: { redactedFields },
  };
}