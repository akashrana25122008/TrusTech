/* ------------------------------------------------------------------ *
 * RiskManager — consequence-based action gating.
 *
 * Risk answers ONE question: "how consequential is this action if it
 * executes?" It is deliberately separate from confidence (how sure the
 * planner is) and trust (how trustworthy the site is).
 *
 *   LOW      — routine, reversible browsing. Never gated.
 *   MEDIUM   — reversible-but-notable state change. Advisory only.
 *   HIGH     — consequential / hard-to-reverse. Requires confirmation.
 *   CRITICAL — destructive / dangerous. Requires confirmation.
 *
 * In particular: an external URL is NOT risk by itself. Ordinary
 * navigation (navigate / new_tab / switch_tab / reload / back / forward)
 * is LOW and runs autonomously.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import { scanText } from "@/privacy/fusion";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  requiresConfirmation: boolean;
}

/* ---- consequence signals (matched against target name / text / url) ---- */

/** Irreversible account/data destruction. */
const CRITICAL_PHRASES =
  /delete\s+(my|the|your)\s+(account|profile)|permanently\s+delete|permanent\s+deletion|\bwipe\s+(my|all|everything|device)|erase\s+(my|all|everything)|close\s+(my|your)\s+(account|profile)|terminate\s+(my|your)\s+account/i;

/** Hard-to-reverse destruction (non-account) and money movement. */
const HIGH_DESTRUCTIVE =
  /\b(delete|destroy|terminate|erase|wipe|empty\s+trash)\b/i;
const HIGH_FINANCIAL =
  /\b(buy(\s+now)?|pay(\s+now)?|purchase|checkout|place\s+order|order\s+now|transfer(\s+money)?|send\s+money|payment|confirm\s+(booking|payment|order)|pay\s+for)\b/i;
/** Final-commit booking language ("Book now", "Confirm reservation"). */
const HIGH_BOOKING_COMMIT =
  /\b(book|reserve)(.*(now|final|confirm|payment|pay))|(confirm|finalize).*(booking|reservation|purchase|order)/i;

/** Security-credential changes and consequential messaging. */
const HIGH_CREDENTIAL_CHANGE =
  /change\s+password|reset\s+password|new\s+(password|pin)|update\s+(password|pin|2fa)|disable\s+2fa|send\s+(email|message)\b.*(boss|client|team|all)|post\s+publicly/i;

/** File upload / document handoff — data leaves the device. */
const HIGH_UPLOAD =
  /\bupload\b|attach\s+(file|document|photo)/i;

/** Reversible-but-notable: form submission, persistence, downloads, settings. */
const MEDIUM_PHRASES =
  /\b(submit|save(\s+changes)?|apply|download|unsubscribe|remove\s+from\s+cart|add\s+to\s+cart|log\s*in|sign\s*in|account\s+settings|settings|preferences)\b/i;
/** Bare booking language without commit words (selecting, not paying). */
const MEDIUM_BOOKING = /\b(book|reserve)\b/i;

/** Explicitly routine / navigational. */
const LOW_NAV_WORDS =
  /^(search|next|previous|open|read\s+more|play|filter|sort|back|home|menu|show\s+more|view|details|watch|learn\s+more)\b/i;

/** Sensitive typed content: secrets, codes, long digit runs. */
const SENSITIVE_TEXT = /\d{4,}|otp|password|pin\b|2fa|cvv|card|cvc|ssn|secret/i;

function stableText(action: AgentAction, snapshot?: ObservationSnapshot): string {
  return [
    action.target?.name ?? "",
    action.text ?? "",
    action.option ?? "",
    action.reason ?? "",
    action.url ?? "",
    snapshot?.url ?? "",
  ].join(" \n ");
}

/**
 * Enrich an action with its target's human-visible label from the current
 * observation before risk assessment. The planner/LLM only carry elementIds;
 * without this step the risk engine would be blind to WHAT is being clicked
 * or typed into. Returns a copy — the planned action itself is untouched.
 */
export function resolveTargetContext(
  action: AgentAction,
  snapshot: ObservationSnapshot,
): AgentAction {
  const id = action.target?.elementId;
  if (!id) return action;
  const el = snapshot.elements.find((e) => e.id === id);
  if (!el) return action;
  return {
    ...action,
    target: {
      ...action.target,
      role: action.target?.role ?? el.role,
      name: action.target?.name ?? el.name,
    },
  };
}

export function assessAction(
  action: AgentAction,
  snapshot?: ObservationSnapshot,
): RiskAssessment {
  const text = stableText(action, snapshot);
  const reasons: string[] = [];

  /* ---- CRITICAL: destructive / dangerous ---- */
  if (CRITICAL_PHRASES.test(text)) {
    reasons.push("Destructive, effectively irreversible action (e.g. account deletion)");
    return { level: "CRITICAL", reasons, requiresConfirmation: true };
  }

  /* ---- HIGH: consequential / hard-to-reverse ---- */
  if (HIGH_FINANCIAL.test(text)) {
    reasons.push("Financial commitment (purchase / payment / money transfer)");
    return { level: "HIGH", reasons, requiresConfirmation: true };
  }
  if (HIGH_BOOKING_COMMIT.test(text)) {
    reasons.push("Final booking/payment confirmation");
    return { level: "HIGH", reasons, requiresConfirmation: true };
  }
  if (HIGH_DESTRUCTIVE.test(text)) {
    reasons.push("Destructive action (delete / destroy / wipe)");
    return { level: "HIGH", reasons, requiresConfirmation: true };
  }
  if (HIGH_CREDENTIAL_CHANGE.test(text)) {
    reasons.push("Security-credential change or consequential outbound message");
    return { level: "HIGH", reasons, requiresConfirmation: true };
  }
  if (HIGH_UPLOAD.test(text)) {
    reasons.push("File upload / document handoff leaves the device");
    return { level: "HIGH", reasons, requiresConfirmation: true };
  }
  if (action.action === "type") {
    const field = (action.target?.name ?? "").toLowerCase();
    if (/password|otp|pin\b|2fa|cvv|cvc|card\s*(number|no)|ssn/i.test(field)) {
      reasons.push("Typing into a credential / payment field");
      return { level: "HIGH", reasons, requiresConfirmation: true };
    }
    if (action.text && SENSITIVE_TEXT.test(action.text.toLowerCase())) {
      reasons.push("Typed text looks like a secret, code, or account number");
      return { level: "HIGH", reasons, requiresConfirmation: true };
    }
    // Feature #1 integration: typed personal data (emails, phones,
    // Aadhaar/PAN/…) is consequential — the user should see it first.
    // Detection only; values never leave this assessment.
    if (action.text) {
      const pii = scanText(action.text).map((f) => f.type.toUpperCase());
      if (pii.length > 0) {
        reasons.push(`Typing detected personal data (${[...new Set(pii)].join(",")})`);
        return { level: "HIGH", reasons, requiresConfirmation: true };
      }
    }
  }

  /* ---- MEDIUM: reversible-but-notable (advisory, never gated) ---- */
  switch (action.action) {
    case "close_tab":
      reasons.push("Closing a tab discards its in-memory state (reopenable)");
      return { level: "MEDIUM", reasons, requiresConfirmation: false };
    case "submit":
      reasons.push("Form submission may change server-side state");
      return { level: "MEDIUM", reasons, requiresConfirmation: false };
    default:
      break;
  }
  if (MEDIUM_PHRASES.test(text) || MEDIUM_BOOKING.test(text)) {
    reasons.push("Reversible state change (save / submit / download / settings / booking selection)");
    return { level: "MEDIUM", reasons, requiresConfirmation: false };
  }

  /* ---- LOW: routine browsing. External URLs are not risk. ---- */
  if (LOW_NAV_WORDS.test((action.target?.name ?? action.text ?? "").trim())) {
    reasons.push("Routine navigational control");
  } else if (action.action === "navigate") {
    reasons.push("Routine task navigation");
  } else {
    reasons.push("Routine, reversible interaction");
  }
  return { level: "LOW", reasons, requiresConfirmation: false };
}
