/* ------------------------------------------------------------------ *
 * TaskIntent — compact, typed normalization of the user's original
 * request. Built ONCE per run from the goal string; NEVER mutated by
 * page content afterwards (RULE 1: webpage instructions cannot rewrite
 * user intent — the object is not even handed a snapshot).
 *
 * This is the anchor every drift check compares against.
 * ------------------------------------------------------------------ */

import type { TaskGoal } from "./types";

export type TaskOperation =
  | "SEARCH"
  | "FIND"
  | "FILTER"
  | "COMPARE"
  | "VIEW"
  | "COLLECT"
  | "NAVIGATE"
  | "INPUT"
  | "SUBMIT"
  | "TRANSACTION"
  | "OTHER";

export interface TaskConstraint {
  type: "max_price" | "site" | "platform" | "query" | "category" | "date" | "other";
  value: string;
}

export interface TaskIntent {
  taskId: string;
  /** Original goal text (kept in memory only — never logged verbatim). */
  goal: string;
  operation: TaskOperation;
  /** Operation kinds this task may legitimately perform. */
  allowedOps: TaskOperation[];
  /** True when the user explicitly asked for state-changing commitment
   * (buy/book/pay/submit/register). TRANSACTION/SUBMIT ops need this. */
  transactional: boolean;
  /** Shorthand boundary label for UI/explanations. */
  boundary: "SEARCH_ONLY" | "RESEARCH" | "INTERACT" | "TRANSACT" | "OPEN";
  entities: Array<{ label: string; value: string }>;
  constraints: TaskConstraint[];
  /** Seed hosts, derived from the goal's destination (start URL host). */
  seedHosts: string[];
}

const CONSTRAINT_TYPES = ["price", "site", "platform", "query", "category", "date"] as const;
const TRANSACTION_VERBS =
  /\b(buy|buys|purchase|order|checkout|pay|payment|book|booking|reserve|subscribe|send money|transfer money|register|sign up|signup|apply for)\b/i;
const SUBMIT_VERBS = /\b(submit|send|confirm|complete|finish|fill\b.*\bform\b|log\s?in|sign\s?in)\b/i;

const BASE_OPS: Record<TaskOperation, TaskOperation[]> = {
  SEARCH: ["SEARCH", "VIEW", "FILTER", "COLLECT", "NAVIGATE", "OTHER"],
  FIND: ["SEARCH", "VIEW", "COLLECT", "NAVIGATE", "OTHER"],
  FILTER: ["FILTER", "VIEW", "SEARCH", "NAVIGATE", "OTHER"],
  COMPARE: ["COMPARE", "VIEW", "FILTER", "SEARCH", "COLLECT", "NAVIGATE", "OTHER"],
  VIEW: ["VIEW", "COLLECT", "NAVIGATE", "OTHER"],
  COLLECT: ["COLLECT", "VIEW", "NAVIGATE", "OTHER"],
  NAVIGATE: ["NAVIGATE", "VIEW", "OTHER"],
  INPUT: ["INPUT", "VIEW", "SEARCH", "NAVIGATE", "OTHER"],
  SUBMIT: ["SUBMIT", "INPUT", "VIEW", "NAVIGATE", "OTHER"],
  TRANSACTION: ["TRANSACTION", "SUBMIT", "INPUT", "VIEW", "NAVIGATE", "OTHER"],
  OTHER: ["NAVIGATE", "VIEW", "INPUT", "OTHER"],
};

function operationFor(intent: TaskGoal["intent"], goal: string): TaskOperation {
  if (TRANSACTION_VERBS.test(goal)) return "TRANSACTION";
  if (SUBMIT_VERBS.test(goal)) return "SUBMIT";
  switch (intent) {
    case "search":
      return "SEARCH";
    case "navigation":
      return "NAVIGATE";
    case "commerce":
      return "COMPARE";
    case "form":
      return "INPUT";
    case "media":
    case "reading":
      return "VIEW";
    case "booking":
      return "TRANSACTION";
    case "download":
      return "COLLECT";
    default:
      return "OTHER";
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Normalize a parsed goal into a TaskIntent. Pure + deterministic.
 * Page state is deliberately NOT an input — intent comes from the user.
 */
export function buildTaskIntent(taskId: string, task: TaskGoal): TaskIntent {
  const operation = operationFor(task.intent, task.goal);
  const transactional =
    operation === "TRANSACTION" ||
    operation === "SUBMIT" ||
    TRANSACTION_VERBS.test(task.goal) ||
    task.intent === "form" ||
    task.intent === "booking";
  const allowedOps = [...BASE_OPS[operation]];
  if (transactional && !allowedOps.includes("TRANSACTION")) allowedOps.push("TRANSACTION", "SUBMIT");
  if (transactional && !allowedOps.includes("SUBMIT")) allowedOps.push("SUBMIT");

  // Widen back to the full union (the `transactional` const above
  // narrows `operation` in false-branches via aliased conditions).
  const opForBoundary: TaskOperation = operation;
  const boundary: TaskIntent["boundary"] = transactional
    ? "TRANSACT"
    : opForBoundary === "SEARCH" || opForBoundary === "FIND" || opForBoundary === "COMPARE"
      ? opForBoundary === "SEARCH"
        ? "SEARCH_ONLY"
        : "RESEARCH"
      : opForBoundary === "INPUT" || opForBoundary === "SUBMIT"
        ? "INTERACT"
        : "OPEN";

  const seedHosts: string[] = [];
  const startHost = hostOf(task.startUrl);
  if (startHost) seedHosts.push(startHost);

  return {
    taskId,
    goal: task.goal,
    operation,
    allowedOps,
    transactional,
    boundary,
    entities: task.entities.map((e) => ({ label: e.label, value: e.value })),
    constraints: task.entities
      .filter((e) => (CONSTRAINT_TYPES as readonly string[]).includes(e.label))
      .map((e) => ({
        type: (e.label === "price" ? "max_price" : e.label) as TaskConstraint["type"],
        value: e.value,
      })),
    seedHosts,
  };
}

/** Goal/entity token set for relevance scoring (local only). */
export function intentTokens(intent: TaskIntent): string[] {
  const haystack = [intent.goal, ...intent.entities.map((e) => `${e.label} ${e.value}`)]
    .join(" ")
    .toLowerCase();
  return haystack.split(/\W+/).filter((t) => t.length > 2);
}
