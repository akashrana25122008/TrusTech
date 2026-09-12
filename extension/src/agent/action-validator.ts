/* ------------------------------------------------------------------ *
 * ActionValidator — validates a proposed action against the current
 * observation before it is executed. Catches planning/grounding
 * failures the controller never found.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";

export interface ValidationError {
  ok: false;
  reasons: string[];
}

export interface ValidationErrorSuccess {
  ok: true;
}

export type ValidationResult = ValidationErrorSuccess | ValidationError;

const NAV_ONLY = new Set(["navigate", "new_tab", "close_tab", "switch_tab", "reload", "finish", "ask_user"]);
const VALIDATE_ACTUAL = new Set(["click", "type", "select", "clear", "check", "uncheck", "radio", "submit", "focus"]);
const TAB_ACTIONS = new Set(["new_tab", "close_tab", "switch_tab"]);

export function validateAction(
  action: AgentAction,
  snapshot: ObservationSnapshot,
): ValidationResult {
  if (TAB_ACTIONS.has(action.action)) return { ok: true };
  if (NAV_ONLY.has(action.action)) return { ok: true };

  // SEARCH validates its target only when the planner attached one — a
  // targetless search self-resolves the field in the executor, which
  // fails honestly when no search field exists.
  if (action.action === "search" && !action.target) return { ok: true };
  if (action.action === "search" && action.target) {
    const target = action.target;
    if (!target.elementId && !target.selector && !(target.role && target.name)) {
      return { ok: false, reasons: [`action "search" requires a target (elementId, role+name, or selector)`] };
    }
    if (target.elementId) {
      const indexed = snapshot.elements.find((e) => e.id === target.elementId);
      if (!indexed) {
        return { ok: false, reasons: [`element "${target.elementId}" is not in the current observation`] };
      }
      if (!indexed.visible) {
        return { ok: false, reasons: [`element "${target.elementId}" is not visible`] };
      }
      if (!indexed.enabled) {
        return { ok: false, reasons: [`element "${target.elementId}" is disabled`] };
      }
    }
    return { ok: true };
  }

  // Actions that manipulate the page need a valid, live target.
  if (VALIDATE_ACTUAL.has(action.action)) {
    const target = action.target;
    if (!target || (!target.elementId && !target.selector && !(target.role && target.name))) {
      return { ok: false, reasons: [`action "${action.action}" requires a target (elementId, role+name, or selector)`] };
    }

    if (target.elementId) {
      const indexed = snapshot.elements.find((e) => e.id === target.elementId);
      if (!indexed) {
        return { ok: false, reasons: [`element "${target.elementId}" is not in the current observation`] };
      }
      if (!indexed.visible) {
        return { ok: false, reasons: [`element "${target.elementId}" is not visible`] };
      }
      if (!indexed.enabled) {
        return { ok: false, reasons: [`element "${target.elementId}" is disabled`] };
      }
    }
  }

  return { ok: true };
}