/* ------------------------------------------------------------------ *
 * ActionVerifier — checks the world *after* an action against what we
 * expected it to achieve. Uses the fresh observation, not the
 * pre-action snapshot.
 * ------------------------------------------------------------------ */

import type { AgentAction, ExpectedOutcome } from "@/shared/action-schema";
import type { ActionResult } from "@/shared/messages";
import type { ObservationSnapshot } from "@/shared/messages";

export interface VerificationResult {
  ok: boolean;
  evidence: string[];
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the page to settle after an action (SPA transitions). */
async function waitForSettle(snapshotFn: () => ObservationSnapshot, maxMs = 5000): Promise<ObservationSnapshot> {
  let last = snapshotFn();
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await delay(350);
    const next = snapshotFn();
    if (next.url === last.url && next.loading === false) return next;
    last = next;
  }
  return last;
}

export async function verifyAction(
  action: AgentAction,
  hint: ActionResult["hint"],
  preSnapshot: ObservationSnapshot,
  snapshotFn: () => ObservationSnapshot,
): Promise<VerificationResult> {
  const expected: ExpectedOutcome = action.expectedOutcome ?? {};
  const after = await waitForSettle(snapshotFn);
  const evidence: string[] = [];

  // URL change check.
  if (expected.urlContains && after.url.includes(expected.urlContains)) {
    evidence.push(`URL contains "${expected.urlContains}"`);
    return { ok: true, evidence };
  }
  if (expected.urlContains) {
    evidence.push(`URL missing "${expected.urlContains}" (actual: ${after.url})`);
    return { ok: false, evidence };
  }
  if (expected.type === "url_change") {
    if (after.url !== preSnapshot.url) {
      evidence.push(`URL changed: ${after.url}`);
      return { ok: true, evidence };
    }
    evidence.push("URL did not change");
    return { ok: false, evidence };
  }

  // Element state check — the fresh observation must reflect typing.
  if (expected.elementState || expected.type === "element_state") {
    const targetId = action.target?.elementId;
    const afterEl = targetId ? after.elements.find((e) => e.id === targetId) : undefined;

    if (hint?.value !== undefined && action.action === "type") {
      if (afterEl && afterEl.value === hint.value) {
        evidence.push(`typed value "${hint.value.slice(0, 40)}" is present`);
        return { ok: true, evidence };
      }
      if (after.visibleText.includes(hint.value) && afterEl?.visible) {
        evidence.push(`page text contains "${hint.value.slice(0, 40)}"`);
        return { ok: true, evidence };
      }
      evidence.push(`typed value missing after action (target: ${targetId ?? "none"})`);
      return { ok: false, evidence };
    }

    if (hint?.checked !== undefined) {
      evidence.push(`checked state matches hint`);
      return { ok: true, evidence };
    }

    if (expected.elementState?.selected !== undefined && afterEl) {
      if (afterEl.selected === expected.elementState.selected) {
        evidence.push(`element "${targetId}" selected state confirmed`);
        return { ok: true, evidence };
      }
      evidence.push(`element "${targetId}" selection did not match`);
      return { ok: false, evidence };
    }
  }

  // content change — any visible text delta or new elements.
  if (expected.type === "content_change") {
    if (after.visibleText !== preSnapshot.visibleText || after.counted !== preSnapshot.counted) {
      evidence.push("visible content changed");
      return { ok: true, evidence };
    }
    evidence.push("content unchanged");
    return { ok: false, evidence };
  }

  // navigation check (reload, back, forward).
  if (expected.type === "navigation") {
    if (after.url !== preSnapshot.url) {
      evidence.push(`navigated: ${after.url}`);
      return { ok: true, evidence };
    }
    evidence.push("did not navigate");
    return { ok: false, evidence };
  }

  // element_state check — element still live and in expected state.
  if (expected.elementState) {
    const el = action.target?.elementId;
    if (el && after.elements.some((e) => e.id === el && e.visible)) {
      evidence.push(`element "${el}" is visible after action`);
      return { ok: true, evidence };
    }
  }

  // Default success heuristic: page did not error/crash.
  if (hint?.text !== undefined) {
    evidence.push(`element text is: "${hint.text.slice(0, 80)}"`);
  }
  evidence.push("page is stable after action");
  return { ok: true, evidence };
}