/* ------------------------------------------------------------------ *
 * ResponseParser — turns raw model output into schema-validated
 * actions. Handles code fences and JSON arrays; rejects anything that
 * is not a clean action object. The controller never touches strings
 * beyond this boundary.
 * ------------------------------------------------------------------ */

import { validateAction, ALL_ACTION_NAMES, type AgentAction, type ActionValidation } from "@/shared/action-schema";

/** Strip ```json … ``` fences and surrounding prose. */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  if (body.startsWith("[") && body.endsWith("]")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) return body.slice(start, end + 1);
  return body;
}

export interface ParsedActions {
  ok: boolean;
  actions: AgentAction[];
  errors: string[];
}

export function parseActions(raw: string, allowed: readonly AgentAction["action"][] = ALL_ACTION_NAMES): ParsedActions {
  const actions: AgentAction[] = [];
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { ok: false, actions, errors: ["model returned invalid JSON"] };
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    const validation: ActionValidation = validateAction(item, allowed as never);
    if (validation.ok && validation.action) {
      actions.push(validation.action);
    } else {
      errors.push(...validation.errors);
    }
  }

  return { ok: errors.length === 0 && actions.length > 0, actions, errors };
}