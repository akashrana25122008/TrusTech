/* ------------------------------------------------------------------ *
 * TargetVerifier — snapshot-side target verification for the safety
 * gate. Answers, against the CURRENT observation (never a stale plan):
 * does the target exist, is it actionable, does its label match, is it
 * unique, and is the page the planner saw still the page we have?
 *
 * Live-DOM grounding (content/grounder.ts) stays the executor-side
 * mechanism; this verifier is the pre-execution policy check. Both
 * must agree before a consequential action runs.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { IndexedElement, ObservationSnapshot } from "@/shared/messages";
import { actionCapabilityLevel } from "@/shared/pages";

export type TargetStatus =
  | "verified"
  | "ambiguous"
  | "missing"
  | "hidden"
  | "disabled"
  | "label_mismatch"
  | "stale";

export interface TargetVerification {
  status: TargetStatus;
  /** 0..1 target-side confidence contribution. */
  confidence: number;
  /** Candidate matches (ambiguity signal). */
  matches: number;
  method?: "id" | "role+name" | "text" | "none";
  reason: string;
}

export interface TargetCheckContext {
  /**
   * Tab URL seen by the tab query just before observation. When set and
   * different from the snapshot URL, the observation no longer describes
   * the live page → stale, do not execute.
   */
  tabUrl?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function labelAgrees(elementName: string, expected?: string): boolean {
  if (!expected || !expected.trim()) return true; // nothing claimed
  const want = norm(expected);
  const have = norm(elementName);
  if (!have) return false;
  return have.includes(want) || want.includes(have);
}

function visibleCandidates(elements: IndexedElement[]): IndexedElement[] {
  return elements.filter((e) => e.visible);
}

/** Count visible elements matching role+name (ambiguity probe). */
export function countRoleNameMatches(
  elements: IndexedElement[],
  role?: string,
  name?: string,
): IndexedElement[] {
  const want = name ? norm(name) : "";
  return visibleCandidates(elements).filter((el) => {
    if (role && el.role !== role) return false;
    if (want) {
      const have = norm(el.name);
      if (!have || (!have.includes(want) && !want.includes(have))) return false;
    }
    return true;
  });
}

/**
 * Verify an action's target against a snapshot. Pure + deterministic —
 * no DOM access, no network, safe to unit-test exhaustively.
 */
export function verifyTarget(
  action: AgentAction,
  snapshot: ObservationSnapshot,
  ctx: TargetCheckContext = {},
): TargetVerification {
  // Browser-level and terminal actions need no page target.
  if (actionCapabilityLevel(action.action) !== "page") {
    return { status: "verified", confidence: 0.9, matches: 0, method: "none", reason: "no page target required" };
  }

  // Staleness first: never verify against a superseded page.
  if (ctx.tabUrl && snapshot.url && ctx.tabUrl !== snapshot.url) {
    return {
      status: "stale",
      confidence: 0.2,
      matches: 0,
      reason: `page changed (planned for ${ctx.tabUrl}, observing ${snapshot.url})`,
    };
  }

  const target = action.target;
  if (!target || (!target.elementId && !target.role && !target.name && !target.selector)) {
    // Viewport/keyboard-level actions the validator permits without an
    // element reference (scroll, press_key, wait, …) always address the
    // live viewport — verifiable by construction, never "unknown".
    return { status: "verified", confidence: 0.85, matches: 0, method: "none", reason: "viewport-level action, no element target" };
  }

  if (target.elementId) {
    const el = snapshot.elements.find((e) => e.id === target.elementId);
    if (!el) {
      return { status: "missing", confidence: 0, matches: 0, method: "id", reason: `element "${target.elementId}" is not in the current observation` };
    }
    if (!el.visible) {
      return { status: "hidden", confidence: 0.25, matches: 1, method: "id", reason: `element "${target.elementId}" is not visible` };
    }
    if (!el.enabled) {
      return { status: "disabled", confidence: 0.25, matches: 1, method: "id", reason: `element "${target.elementId}" is disabled` };
    }
    if (!labelAgrees(el.name, target.name)) {
      return {
        status: "label_mismatch",
        confidence: 0.45,
        matches: 1,
        method: "id",
        reason: `element "${target.elementId}" label changed (no longer matches)`,
      };
    }
    return { status: "verified", confidence: 0.95, matches: 1, method: "id", reason: "target live, visible, enabled, label agrees" };
  }

  // Semantic reference: uniqueness is the safety property.
  const matches = countRoleNameMatches(snapshot.elements, target.role, target.name);
  if (matches.length === 0) {
    return { status: "missing", confidence: 0, matches: 0, method: "role+name", reason: "no visible element matches role+name" };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      confidence: 0.4,
      matches: matches.length,
      method: "role+name",
      reason: `${matches.length} visible elements match — refusing to pick arbitrarily`,
    };
  }
  const only = matches[0];
  if (!only.enabled) {
    return { status: "disabled", confidence: 0.25, matches: 1, method: "role+name", reason: "matched element is disabled" };
  }
  return { status: "verified", confidence: 0.85, matches: 1, method: "role+name", reason: "unique visible match" };
}
