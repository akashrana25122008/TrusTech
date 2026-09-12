/* ------------------------------------------------------------------ *
 * DeterministicPlanner — local-only step-based planner. No LLM needed
 * for simple intents; produces one AgentAction at a time, driven by
 * the current observation and the goal's step list.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import { taskStepsFrom, type TaskGoal, type PlannerPlan } from "./types";

export interface PlannerAction {
  action: AgentAction;
  justification: string;
  /**
   * Proposed task plan. The planner attaches it on the first decision
   * (stepIndex === 0); the controller stores it as the timeline and
   * re-plans replace the remaining steps. Later decisions omit it.
   */
  plan?: PlannerPlan;
}

/** Best matching element for a given role/name/text signal from the snapshot. */
function bestMatch(
  snapshot: ObservationSnapshot,
  role?: string,
  text?: string,
): string | undefined {
  let bestScore = -1;
  let bestId: string | undefined;
  for (const el of snapshot.elements) {
    if (!el.visible) continue;
    let score = 0;
    if (role && el.role === role) score += 2;
    if (text && (el.name.toLowerCase().includes(text.toLowerCase()) || (el.text ?? "").toLowerCase().includes(text.toLowerCase()))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestId = el.id;
    }
  }
  return bestId;
}

function planStep(
  goal: TaskGoal,
  stepIndex: number,
  snapshot: ObservationSnapshot,
): PlannerAction | null {
  const step = goal.steps[stepIndex];
  if (!step) return null;
  const stepLower = step.toLowerCase();

  // Destination steps navigate to the goal's start URL. Steps about a
  // specific media item ("open the selected video", "select a relevant
  // result") are NOT destination steps — they are handled below against
  // the live page, otherwise the agent would navigate away instead of
  // opening the video.
  const isDestinationStep =
    /navigate|go to|open|visit|load|page|site|url|website|platform/.test(stepLower);
  const isMediaItemStep =
    /selected video|relevant result|first video/i.test(stepLower);
  if (isDestinationStep && !isMediaItemStep && goal.startUrl) {
    return {
      action: {
        action: "navigate",
        url: goal.startUrl,
        confidence: 0.8,
        expectedOutcome: { type: "url_change", urlContains: goal.startUrl },
      },
      justification: step,
    };
  }

  if (/submit|press enter/.test(stepLower)) {
    return {
      action: {
        action: "press_key",
        key: "Enter",
        confidence: 0.85,
        expectedOutcome: { type: "content_change" },
      },
      justification: step,
    };
  }

  if (/enter the query|enter.*search|type.*query/.test(stepLower)) {
    const inputId = bestMatch(snapshot, "textbox") ?? bestMatch(snapshot, "searchbox");
    if (inputId) {
      // Prefer an extracted search topic ("Python compiler") over a bare
      // platform/site name — the platform is WHERE we search, not WHAT.
      const targetText =
        goal.entities.find((e) => e.label === "query")?.value ??
        goal.entities.find((e) => e.label !== "site" && e.label !== "platform")?.value ??
        goal.goal;
      return {
        action: {
          action: "type",
          target: { elementId: inputId },
          text: targetText,
          confidence: 0.9,
          expectedOutcome: { type: "element_state" },
        },
        justification: step,
      };
    }
  }

  // In-platform media flow: pick a result link and open it. When the browser
  // already shows a video page the step is complete — finish with the page
  // content instead of clicking into related videos.
  if (/select.*result|open.*video|first.*video|play.*video/.test(stepLower)) {
    if (/\/watch[?/]|youtube\.com\/watch|youtu\.be\//i.test(snapshot.url)) {
      return {
        action: { action: "finish", result: snapshot.visibleText.slice(0, 500), confidence: 0.75 },
        justification: `already on a video page: ${snapshot.url}`,
      };
    }
    const link = snapshot.elements.find(
      (e) => e.visible && (e.role === "link" || e.tag === "a"),
    );
    if (link) {
      return {
        action: {
          action: "click",
          target: { elementId: link.id },
          confidence: 0.85,
          expectedOutcome: { type: "url_change" },
        },
        justification: step,
      };
    }
  }

  if (/choose|select|pick/.test(stepLower)) {
    // Date picker — an input[type=date] and a date in the goal.
    if (/date/.test(stepLower)) {
      const dateEl = snapshot.elements.find((e) => e.type === "date");
      if (dateEl) {
        const value = goal.entities.find((e) => e.label === "date")?.value ?? "2026-01-01";
        return {
          action: {
            action: "type",
            target: { elementId: dateEl.id },
            text: value,
            confidence: 0.85,
            expectedOutcome: { type: "element_state" },
          },
          justification: step,
        };
      }
    }
    // Dropdown / listbox — select a named option.
    const combo =
      snapshot.elements.find((e) => e.role === "combobox") ??
      snapshot.elements.find((e) => e.type === "select-one") ??
      snapshot.elements.find((e) => e.role === "listbox");
    const option = goal.entities.find((e) => e.label === "option")?.value;
    if (combo && option) {
      return {
        action: {
          action: "select",
          target: { elementId: combo.id },
          option,
          confidence: 0.85,
          expectedOutcome: { type: "element_state", elementState: { selected: true } },
        },
        justification: step,
      };
    }
  }

  if (/read|return the top|compare|present|see/.test(stepLower)) {
    return {
      action: { action: "finish", result: snapshot.visibleText.slice(0, 500), confidence: 0.7 },
      justification: step,
    };
  }

  // Generic fallback: read the page and finish.
  return {
    action: { action: "finish", result: snapshot.visibleText.slice(0, 500), confidence: 0.5 },
    justification: `no deterministic action for step "${step}"; reading page`,
  };
}

/**
 * Deterministic next-action planner. The local task-sourced plan is attached
 * to the first decision so the controller can seed the Action Timeline when
 * no provider is involved.
 */
export function planNextAction(
  goal: TaskGoal,
  stepIndex: number,
  snapshot: ObservationSnapshot,
): PlannerAction | null {
  const decision = planStep(goal, stepIndex, snapshot);
  if (!decision) return null;
  if (stepIndex === 0) {
    decision.plan = { steps: taskStepsFrom(goal.steps), source: "local" };
  }
  return decision;
}