/* ------------------------------------------------------------------ *
 * Privacy decision layer — consumes the fused SensitiveRegion[].
 *
 * The final privacy decision is derived ONLY from fused regions and
 * reuses the firewall's policy semantics (hardBlock for HIGH-severity
 * credentials / government identity / biometric evidence). Nothing here
 * re-scans text or reclassifies — it turns evidence into an action.
 * ------------------------------------------------------------------ */

import {
  type PrivacyPolicy,
  DEFAULT_POLICY,
} from "./firewall";
import type { RegionSeverity, SensitiveRegion, SensitiveType } from "./regions";

export type PrivacyAction = "none" | "sanitize" | "block" | "warn";

export interface PrivacyDecision {
  sensitivePresent: boolean;
  regionCount: number;
  verdict: "SAFE" | "SCANNING" | "ALERT";
  action: PrivacyAction;
  maxSeverity: RegionSeverity | null;
  maxConfidence: number;
  types: SensitiveType[];
  urgent: SensitiveType[];
  /** Human-readable evidence summary — contains NO raw PII values. */
  evidenceBrief: string;
}

const SEVERITY_RANK: Record<RegionSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Decide what TrusTech must do given the fused regions. Respects the
 * existing policy: HIGH-severity regions with hardBlock → ALERT/block;
 * any region → SCANNING (sanitize detectable text content).
 */
export function decidePrivacy(regions: readonly SensitiveRegion[], policy: PrivacyPolicy = {}): PrivacyDecision {
  const { hardBlock = true } = { ...DEFAULT_POLICY, ...policy };

  if (regions.length === 0) {
    return {
      sensitivePresent: false,
      regionCount: 0,
      verdict: "SAFE",
      action: "none",
      maxSeverity: null,
      maxConfidence: 0,
      types: [],
      urgent: [],
      evidenceBrief: "No sensitive regions detected",
    };
  }

  const maxSeverity = regions.reduce<RegionSeverity>((acc, r) =>
    SEVERITY_RANK[r.severity] > SEVERITY_RANK[acc] ? r.severity : acc, "low");
  const maxConfidence = Math.max(...regions.map((r) => r.confidence));
  const types = [...new Set(regions.map((r) => r.type))];
  const urgent = [...new Set(regions.filter((r) => r.severity === "high").map((r) => r.type))];

  const block = urgent.length > 0 && hardBlock;
  const verdict: PrivacyDecision["verdict"] = block ? "ALERT" : "SCANNING";
  const action: PrivacyAction = block ? "block" : "sanitize";

  const brief = types
    .map((t) => {
      const n = regions.filter((r) => r.type === t).length;
      const sources = [...new Set(regions.filter((r) => r.type === t).flatMap((r) => r.sources))];
      return `${t}(${n}) via ${sources.join("+")}`;
    })
    .join(" · ");

  return {
    sensitivePresent: true,
    regionCount: regions.length,
    verdict,
    action,
    maxSeverity,
    maxConfidence: Math.round(maxConfidence * 100) / 100,
    types,
    urgent,
    evidenceBrief: brief,
  };
}