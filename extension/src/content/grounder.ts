/* ------------------------------------------------------------------ *
 * Element grounder — resolves a TargetSpec to a live element using the
 * documented priority (id → role+name → text → selector). Returns a
 * status that the action validator consumes; coordinates are NEVER the
 * primary mechanism.
 * ------------------------------------------------------------------ */

import type { TargetSpec } from "@/shared/action-schema";
import type { GroundingResult } from "@/shared/messages";
import { indexAll, resolveId, isLive, indexElement } from "./indexer";
import { accessibleName, inferRole, isVisible, isEnabled } from "./accessibility-reader";

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

const nameMatches = (el: Element, expected: string, role?: string): boolean => {
  if (role && inferRole(el) !== role) return false;
  const name = normalize(accessibleName(el));
  return name.length > 0 && name.includes(normalize(expected));
};

export function groundTarget(spec: TargetSpec, root: ParentNode = document): GroundingResult {
  // 1. Internal element id — fastest and most precise when live.
  if (spec.elementId) {
    const el = resolveId(spec.elementId);
    if (el && isLive(spec.elementId, root) && isVisible(el) && isEnabled(el)) {
      return { status: "ok", elementId: spec.elementId, method: "id" };
    }
    // Without any semantic fallback the id verdict is final (previous
    // behavior): missing, detached, hidden, or disabled.
    if (!spec.role && !spec.name && !spec.selector) {
      if (!el) return { status: "not_found", method: "id", reason: `no indexed element ${spec.elementId}` };
      if (!isLive(spec.elementId, root)) return { status: "not_found", method: "id", reason: "element detached from DOM" };
      if (!isVisible(el)) return { status: "hidden", elementId: spec.elementId, method: "id" };
      return { status: "disabled", elementId: spec.elementId, method: "id" };
    }
    // Otherwise the id is stale (re-rendered DOM) — fall through and
    // re-ground semantically against the CURRENT tree below.
  }

  // 2. role + accessible name.
  if (spec.role || spec.name) {
    const expected = spec.name ? normalize(spec.name) : "";
    const candidates = indexAll(root).filter((el) => {
      if (spec.role && inferRole(el) !== spec.role) return false;
      if (expected && !nameMatches(el, expected)) return false;
      return isVisible(el);
    });
    if (candidates.length === 0 && expected) {
      // looser pass: name alone
      const loose = indexAll(root).filter((el) => nameMatches(el, expected) && isVisible(el));
      if (loose.length === 1) return okOf(loose[0], "role+name");
    }
    if (candidates.length === 1) return okOf(candidates[0], "role+name");
    if (candidates.length > 1) {
      return { status: "ambiguous", method: "role+name", reason: `${candidates.length} matches for name "${spec.name}"` };
    }
  }

  // 3. visible text search.
  if (spec.name) {
    const byText = indexAll(root).filter((el) => normalize(el.textContent ?? "").includes(normalize(spec.name!)) && isVisible(el));
    if (byText.length === 1) return okOf(byText[0], "text");
    if (byText.length > 1) return { status: "ambiguous", method: "text", reason: `${byText.length} elements contain "${spec.name}"` };
  }

  // 4. stable selector — guarded, never trusted blindly.
  if (spec.selector) {
    try {
      const el = root.querySelector<Element>(spec.selector);
      if (el && isVisible(el) && isEnabled(el)) return okOf(el, "selector");
      if (el) return { status: "hidden", reason: "selector matched but element not actionable" };
    } catch {
      return { status: "not_found", method: "selector", reason: "malformed selector" };
    }
  }

  return { status: "not_found", reason: "target does not match any element" };
}

function okOf(el: Element, method: GroundingResult["method"]): GroundingResult {
  return { status: "ok", elementId: indexElement(el), method };
}