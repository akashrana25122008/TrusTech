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
  if (status === "AWAITING_VERIFY") return "Execution complete — please verify the result on the page.";
  if (status === "VERIFIED") return "Objective verified.";
  if (status === "VERIFY_FAILED") return "Objective not met.";
  return actionText;
}

/** Final-state block for the processing drawer. Null while running. */
export function finalStateSummary(
  status: AgentStateKey,
  actionText: string,
): { label: "COMPLETED" | "STOPPED" | "PAUSED" | "AWAITING VERIFICATION" | "NOT VERIFIED"; detail: string } | null {
  if (status === "SUCCESS") return { label: "COMPLETED", detail: actionText };
  if (status === "ERROR") return { label: "STOPPED", detail: actionText };
  // A paused task is stopped-but-resumable: the drawer shows the pause
  // reason (not a global error) with resume available in the controls.
  if (status === "PAUSED") return { label: "PAUSED", detail: actionText };
  // Execution-complete is not objective-complete: the drawer holds the
  // execution result until the user verifies it on the real page.
  if (status === "AWAITING_VERIFY") return { label: "AWAITING VERIFICATION", detail: actionText };
  if (status === "VERIFIED") return { label: "COMPLETED", detail: actionText };
  if (status === "VERIFY_FAILED") return { label: "NOT VERIFIED", detail: actionText };
  return null;
}
