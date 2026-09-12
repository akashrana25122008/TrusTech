import type { AgentStateKey } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * Status text policy — the landing view is the "minimal companion"
 * view, the processing drawer is the "full truth" view.
 *
 * Main view: neutral, calm, never a technical dump. An ERROR status
 * reads as "Stopped." — the restrained bot state plus the one-word
 * status pill already communicate reality; the raw reason lives in
 * the drawer.
 *
 * Drawer: final execution state (COMPLETED / STOPPED) with the concise
 * reason/result from the real event stream. Nothing fabricated.
 * ------------------------------------------------------------------ */

/** Action line for the main view. */
export function displayActionText(status: AgentStateKey, actionText: string): string {
  if (status === "ERROR") return "Stopped.";
  return actionText;
}

/** Final-state block for the processing drawer. Null while running. */
export function finalStateSummary(
  status: AgentStateKey,
  actionText: string,
): { label: "COMPLETED" | "STOPPED"; detail: string } | null {
  if (status === "SUCCESS") return { label: "COMPLETED", detail: actionText };
  if (status === "ERROR") return { label: "STOPPED", detail: actionText };
  return null;
}
