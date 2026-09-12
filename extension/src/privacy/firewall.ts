/* ------------------------------------------------------------------ *
 * Privacy Firewall — the hard boundary between page content and any
 * external destination (backend API, LLM, logging, telemetry).
 *
 *         page text ──► scanner ──► redactor ──► policy verdict
 *                            ▲
 *                    (PII detector rules)
 * ------------------------------------------------------------------ */

import { detectPii, redactPii, type PiiMatch, type PiiType } from "./detector";

export type PrivacyVerdict = "SAFE" | "SCANNING" | "ALERT";

export interface RedactionEntry {
  type: PiiType;
  segment: string;
}

export interface ScanResult {
  verdict: PrivacyVerdict;
  /** Sanitized text — safe to leave the page. */
  sanitized: string;
  redactions: RedactionEntry[];
  /** Combined privacy score 0-100 (100 = nothing sensitive). */
  score: number;
}

const SENSITIVITY_WEIGHT: Record<PiiType, number> = {
  email: 1,
  phone: 1,
  ipv4: 1,
  postal: 1,
  upi: 2,
  ifsc: 2,
  voter_id: 2,
  driving_licence: 2,
  pan: 2,
  aadhaar: 3,
  ssn: 3,
  credit_card: 3,
  passport: 3,
};

export const DEFAULT_POLICY = {
  keepLength: false as boolean,
  /** Block redaction of banking/secrets entirely when true. */
  hardBlock: true as boolean,
};

export interface PrivacyPolicy {
  keepLength?: boolean;
  hardBlock?: boolean;
}

export class PrivacyFirewall {
  scan(text: string, policy: PrivacyPolicy = {}): ScanResult {
    const { keepLength = false, hardBlock = true } = { ...DEFAULT_POLICY, ...policy };

    const matches: PiiMatch[] = detectPii(text);
    const redactions: RedactionEntry[] = matches.map((m) => ({ type: m.type, segment: m.segment }));

    // Presence of any match forces SCANNING at minimum.
    const rawVerdict: PrivacyVerdict = matches.length === 0 ? "SAFE" : "SCANNING";
    const sensitive = redactions.filter((r) => SENSITIVITY_WEIGHT[r.type] >= 3);
    const verdict: PrivacyVerdict = sensitive.length > 0 && hardBlock ? "ALERT" : rawVerdict;

    const sanitized = redactPii(text, matches, keepLength);

    const penalty = redactions.reduce((sum, r) => sum + SENSITIVITY_WEIGHT[r.type], 0);
    const score = Math.max(0, Math.min(100, 100 - penalty * 12));

    return { verdict, sanitized, redactions, score };
  }

  /** True when outbound traffic must be refused, not merely sanitized. */
  isBlocked(verdict: PrivacyVerdict): boolean {
    return verdict === "ALERT";
  }
}