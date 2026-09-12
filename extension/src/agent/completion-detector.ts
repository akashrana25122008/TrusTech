/* ------------------------------------------------------------------ *
 * CompletionDetector — determines when a task's goal has been met.
 * Heuristic-based for the deterministic path; the LLM can override
 * with an explicit finish action.
 * ------------------------------------------------------------------ */

import type { TaskGoal } from "./types";
import type { ObservationSnapshot } from "@/shared/messages";
import type { MemoryEntry } from "./memory";

export interface CompletionCheck {
  done: boolean;
  reason: string;
}

/** Very simple keyword/goal overlap check. */
function goalOverlap(goal: string, text: string): number {
  const tokens = goal.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const haystack = text.toLowerCase();
  return tokens.filter((t) => haystack.includes(t)).length;
}

/**
 * Actions that only place the tab somewhere. Their success proves WHERE
 * the agent is, never THAT the goal is done: a landing page (YouTube home,
 * Google results, …) routinely mentions goal keywords — recommendations,
 * chrome labels like "YouTube", substrings like "and" — without the task
 * being complete. The keyword heuristic below must therefore never fire on
 * navigation alone; the agent has to have interacted with page content
 * (typed, clicked, submitted, …) first.
 */
const PLACEMENT_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "new_tab",
  "switch_tab",
  "reload",
  "back",
  "forward",
]);

export function checkCompletion(
  goal: TaskGoal,
  currentObservation: ObservationSnapshot,
  memory: readonly MemoryEntry[],
): CompletionCheck {
  // Explicit finish via the action protocol.
  const finishAction = [...memory].reverse().find(
    (e): e is import("./memory").PlannedEntry => e.kind === "planned" && e.action.action === "finish",
  );
  if (finishAction) {
    return { done: true, reason: finishAction.action.result ?? "finish_action" };
  }

  const visible = currentObservation.visibleText;

  // High overlap with goal text → task is likely done, but ONLY when the
  // agent's own content interactions surfaced NEW goal-relevant content:
  //   (a) at least one successful non-placement action (navigation alone is
  //       not progress toward a content goal — see PLACEMENT_ACTIONS), and
  //   (b) the overlap GREW compared to every earlier observation, so words
  //       that were already on the landing page (recommendations, chrome
  //       labels like "YouTube", substrings like "and") can never by
  //       themselves read as completion.
  const overlap = goalOverlap(goal.goal, visible);
  if (overlap >= 4) {
    const observations = memory.filter(
      (e): e is import("./memory").ObservationEntry => e.kind === "observation",
    );
    // The controller pushes the current snapshot just before this check, so
    // the latest observation entry is the page being judged, not history.
    const prior = observations.slice(0, -1);
    const bestPrior = prior.reduce(
      (m, o) => Math.max(m, goalOverlap(goal.goal, o.snapshot.visibleText)),
      0,
    );
    const interacted = memory.some(
      (e) => e.kind === "executed" && e.ok && !PLACEMENT_ACTIONS.has(e.action.action),
    );
    if (interacted && overlap > bestPrior) {
      return { done: true, reason: `goal keywords (${overlap}) match page content` };
    }
  }

  // Explicit ask_user signal.
  const askUser = [...memory].reverse().find(
    (e): e is import("./memory").PlannedEntry => e.kind === "planned" && e.action.action === "ask_user",
  );
  if (askUser) {
    return { done: true, reason: "user escalation via ask_user" };
  }

  return { done: false, reason: "not yet" };
}