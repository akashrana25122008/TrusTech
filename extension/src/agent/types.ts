/* ------------------------------------------------------------------ *
 * Types consumed by the deterministic agent runtime.
 * Extended as needed without touching the shared surface.
 * ------------------------------------------------------------------ */

import type { PlanMeta, TaskData, TaskStep } from "@/shared/types";

export interface Entity {
  label: string;
  value: string;
  raw: string;
}

export interface TaskGoal {
  goal: string;
  intent: "search" | "navigation" | "commerce" | "form" | "media" | "reading" | "booking" | "download" | "general";
  entities: Entity[];
  steps: string[];
  startUrl?: string;
}

/** Turn step descriptions into pending task steps (fallback/local plans). */
export function taskStepsFrom(descriptions: string[], offset = 0): TaskStep[] {
  return descriptions.map((text, i) => ({
    id: `step_${i + 1 + offset}`,
    text,
    status: "pending" as const,
  }));
}

export interface PlannerPlan extends PlanMeta {
  steps: TaskStep[];
  /** Task data that arrives with the plan (inputs/generated/interpretation). */
  data?: TaskData | null;
}