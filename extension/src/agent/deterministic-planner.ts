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

/**
 * Search-field resolution for query entry. Generic signals only (roles +
 * lexical name cues, never site selectors): a searchbox role wins
 * outright; other text-entry roles (textbox, combobox — the roles real
 * search fields actually carry) must also carry a search-ish name, since
 * a bare textbox might be any form control. Returns undefined when
 * nothing genuinely matches — callers fall back to targetless SEARCH
 * (the executor self-resolves) instead of acting on an arbitrary
 * element, which is what mistargeted live typing on real pages.
 */
function bestSearchInput(snapshot: ObservationSnapshot): string | undefined {
  let bestScore = 0;
  let bestId: string | undefined;
  for (const el of snapshot.elements) {
    if (!el.visible || !el.enabled) continue;
    const name = el.name ?? "";
    let score = 0;
    if (el.role === "searchbox") {
      score += 4;
    } else if (el.role === "textbox" || el.role === "combobox") {
      score += 2;
    } else {
      continue;
    }
    // Native <input type=search> is as strong a signal as a searchbox
    // role. Mirrors the executor's findSearchInput scoring so the planner
    // never under-matches a field the executor can already resolve.
    if (el.type === "search") {
      score += 4;
    }
    if (/\bsearch\b/i.test(name)) {
      score += 3;
    } else if (/query|find|lookup/i.test(name)) {
      score += 1;
    } else if (el.role !== "searchbox" && el.type !== "search") {
      // A bare text field with no search cue is not provably the search
      // input — skip it rather than typing a query into a random control.
      continue;
    }
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

  // Search submission is the SEARCH composite — enter (if needed) +
  // submit (Enter, then search-button fallback) + verified results.
  // A bare press_key Enter can no longer represent a search: typing the
  // query is the input stage, not the completed operation.
  // An unrendered page (mid-load observation: no text, no elements)
  // cannot be planned against — settle briefly and re-observe next
  // iteration instead of emitting an empty fallback finish. Destination
  // navigation still proceeds (it is what renders the page).
  if (
    !snapshot.visibleText.trim() &&
    snapshot.elements.length === 0 &&
    snapshot.pageType !== "unsupported" &&
    !isDestinationStep
  ) {
    return {
      action: {
        action: "wait",
        ms: 2500,
        confidence: 0.6,
        expectedOutcome: { type: "noop" },
      },
      justification: "page not yet rendered — settle before planning",
    };
  }

  if (/submit|press enter/.test(stepLower)) {
    // A targetless SEARCH lets the executor resolve the field itself.
    const searchId = bestSearchInput(snapshot);
    const query =
      goal.entities.find((e) => e.label === "query")?.value ??
      goal.entities.find((e) => e.label !== "site" && e.label !== "platform")?.value ??
      goal.goal;
    return {
      action: {
        action: "search",
        ...(searchId ? { target: { elementId: searchId } } : {}),
        text: query,
        confidence: 0.85,
        expectedOutcome: { type: "content_change" },
      },
      justification: step,
    };
  }

  if (/enter the query|enter.*search|type.*query/.test(stepLower)) {
    const inputId = bestSearchInput(snapshot);
    // Prefer an extracted search topic ("Python compiler") over a bare
    // platform/site name — the platform is WHERE we search, not WHAT.
    const targetText =
      goal.entities.find((e) => e.label === "query")?.value ??
      goal.entities.find((e) => e.label !== "site" && e.label !== "platform")?.value ??
      goal.goal;
    if (inputId) {
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
    // No provable search input under the planner's (deliberately narrower)
    // name heuristics. Defer to the executor's strictly richer resolver
    // (aria-label/placeholder/type=search) via a targetless SEARCH — it
    // self-resolves the field and submits. Never act on an arbitrary
    // element; the executor re-passes its own resolver on the page.
    return {
      action: {
        action: "search",
        text: targetText,
        confidence: 0.55,
        expectedOutcome: { type: "content_change" },
      },
      justification: `${step} — no named search field, delegating to executor self-resolution`,
    };
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
    // Relevance first: the link whose name overlaps the task query most is
    // the relevant result. Blindly taking the first link clicks site chrome
    // (verified live: the header logo link won over video results because
    // headers precede results in DOM order). An empty-named link is never
    // a relevant result — mid-render pages stamp names late, and clicking
    // chrome navigates AWAY from the results.
    const queryText = goal.entities.find((e) => e.label === "query")?.value ?? goal.goal;
    const queryTokens = queryText
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const links = snapshot.elements.filter((e) => e.visible && (e.role === "link" || e.tag === "a"));
    const overlap = (name: string): number => {
      const lower = name.toLowerCase();
      return queryTokens.filter((t) => lower.includes(t)).length;
    };
    const named = links.filter((e) => (e.name ?? "").trim().length > 0);
    const ranked = [...named].sort(
      (a, b) => overlap(b.name) - overlap(a.name) || b.name.length - a.name.length,
    );
    const link = ranked[0];
    const best = link ? overlap(link.name) : 0;
    if (!link || best === 0) {
      // No readable result yet — the page may still be rendering (verified
      // live: result links stamp names seconds after navigation while the
      // chrome links are already indexed), or the search genuinely returned
      // nothing useful. Settle one beat and re-observe rather than clicking
      // site chrome or ending the task on a half-painted page. Verification
      // still judges whatever the NEXT step does; steps are finite so this
      // always terminates.
      return {
        action: { action: "wait", ms: 2500, confidence: 0.6, expectedOutcome: { type: "noop" } },
        justification: `${step} — no readable result yet, settling`,
      };
    }
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