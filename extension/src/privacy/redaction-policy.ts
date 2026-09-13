/* ------------------------------------------------------------------ *
 * Redaction policy — the SINGLE auditable layer that decides HOW each
 * sensitive type is redacted.
 *
 *   SensitiveType ──► RedactionMethod + padding + minimum protection
 *
 * Rules are deterministic pure functions: same (type, severity,
 * confidence) always yields the same method. No randomness, no model
 * internals leak into the decision.
 *
 * Security invariant: HIGH-severity credentials / government identity
 * numbers NEVER receive a reversible-looking treatment. They map to
 * BLACKOUT. FACE maps to BLUR (documented, reviewable choice — blur is
 * a presence-hiding transform, not an identity eraser; see KNOWN
 * LIMITATIONS in docs/VISUAL-REDACTION.md). Contact identifiers map to
 * MASK (opaque deterministic pattern).
 * ------------------------------------------------------------------ */

import type { RegionSeverity, SensitiveType } from "./regions";

/** Canonical redaction methods. Closed union — arbitrary strings can
 *  never enter the core pipeline (validated at every boundary). */
export type RedactionMethod = "BLACKOUT" | "BLUR" | "MASK";

export const REDACTION_METHODS: readonly RedactionMethod[] = ["BLACKOUT", "BLUR", "MASK"];

export function isRedactionMethod(value: unknown): value is RedactionMethod {
  return value === "BLACKOUT" || value === "BLUR" || value === "MASK";
}

/** Privacy strength ordering. Higher = harder to reconstruct. When two
 *  operations overlap, the stronger method wins — security beats looks. */
export const METHOD_STRENGTH: Record<RedactionMethod, number> = {
  BLUR: 1,
  MASK: 2,
  BLACKOUT: 3,
};

export function methodStrength(method: RedactionMethod): number {
  return METHOD_STRENGTH[method];
}

export interface TypeRedactionRule {
  /** Default method for this sensitive type. */
  method: RedactionMethod;
  /** Safety margin (px, image space) around the detector box. Detector
   *  boxes may be slightly smaller than the true sensitive content. */
  padding: number;
  /** Minimum confidence for the region to be redacted at all. */
  minConfidence: number;
  /** Floor: the planner upgrades any weaker resolved method to this.
   *  Prevents insecure combinations (e.g. weak BLUR on HIGH identity). */
  minimumMethod: RedactionMethod;
}

export interface RedactionPolicyConfig {
  rules: Record<SensitiveType, TypeRedactionRule>;
  /** Box-blur radius in px (applies to BLUR ops). */
  blurRadius: number;
  /** Opaque BLACKOUT fill color [r,g,b,a]. */
  blackoutColor: [number, number, number, number];
  /** Opaque MASK base color [r,g,b,a]. */
  maskColor: [number, number, number, number];
  /** Opaque MASK hatch accent [r,g,b,a] (deterministic pattern). */
  maskAccent: [number, number, number, number];
  /** Fraction of a BLUR region that must change pixels (0..1) for pixel
   *  verification to pass on non-uniform regions. */
  blurChangedFraction: number;
}

const HIGH_IDENTITY: ReadonlySet<SensitiveType> = new Set([
  "PASSWORD",
  "CARD_NUMBER",
  "AADHAAR",
  "PAN",
  "SSN",
  "PASSPORT",
  "VOTER_ID",
  "DRIVING_LICENSE",
]);

const CONTACT: ReadonlySet<SensitiveType> = new Set(["UPI", "IFSC", "PHONE", "EMAIL"]);

/** Default auditable policy. HIGH identity → BLACKOUT(+8px). FACE →
 *  BLUR(+12px, radius 12). Contact identifiers → MASK(+6px). */
export const DEFAULT_REDACTION_POLICY: RedactionPolicyConfig = {
  rules: {
    FACE: { method: "BLUR", padding: 12, minConfidence: 0.5, minimumMethod: "BLUR" },
    PASSWORD: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    CARD_NUMBER: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    AADHAAR: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    PAN: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    SSN: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    PASSPORT: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    VOTER_ID: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    DRIVING_LICENSE: { method: "BLACKOUT", padding: 8, minConfidence: 0.5, minimumMethod: "BLACKOUT" },
    UPI: { method: "MASK", padding: 6, minConfidence: 0.5, minimumMethod: "MASK" },
    IFSC: { method: "MASK", padding: 6, minConfidence: 0.5, minimumMethod: "MASK" },
    PHONE: { method: "MASK", padding: 6, minConfidence: 0.5, minimumMethod: "MASK" },
    EMAIL: { method: "MASK", padding: 6, minConfidence: 0.5, minimumMethod: "MASK" },
  },
  blurRadius: 12,
  blackoutColor: [0, 0, 0, 255],
  maskColor: [15, 23, 42, 255],
  maskAccent: [56, 189, 248, 255],
  blurChangedFraction: 0.05,
};

export function ruleFor(type: SensitiveType, policy: RedactionPolicyConfig = DEFAULT_REDACTION_POLICY): TypeRedactionRule {
  return policy.rules[type];
}

/**
 * Deterministic method resolution for one region. Returns null when the
 * region must be SKIPPED (below min confidence). Otherwise returns the
 * rule method raised to the applicable floor:
 *   - HIGH severity non-FACE regions: floor is at least MASK (and the
 *     default rules already pin HIGH identity to BLACKOUT).
 *   - A custom policy that maps a HIGH region to BLUR is upgraded to
 *     that type's minimumMethod — insecure combinations cannot pass.
 */
export function resolveMethod(
  type: SensitiveType,
  severity: RegionSeverity,
  confidence: number,
  policy: RedactionPolicyConfig = DEFAULT_REDACTION_POLICY,
): RedactionMethod | null {
  const rule = ruleFor(type, policy);
  if (confidence < rule.minConfidence) return null;
  let method = rule.method;
  const floor: RedactionMethod =
    severity === "high" && type !== "FACE"
      ? methodStrength(rule.minimumMethod) >= methodStrength("MASK")
        ? rule.minimumMethod
        : "MASK"
      : rule.minimumMethod;
  if (methodStrength(method) < methodStrength(floor)) method = floor;
  // HIGH identity numbers must never leave as BLUR under any override.
  if (severity === "high" && HIGH_IDENTITY.has(type) && method === "BLUR") method = "BLACKOUT";
  return method;
}

/** Shallow-merge overrides onto the default policy (audit-friendly). */
export function configurePolicy(overrides: Partial<Omit<RedactionPolicyConfig, "rules">> & { rules?: { [K in SensitiveType]?: Partial<TypeRedactionRule> } }): RedactionPolicyConfig {
  const rules = { ...DEFAULT_REDACTION_POLICY.rules };
  if (overrides.rules) {
    for (const [type, rule] of Object.entries(overrides.rules)) {
      const t = type as SensitiveType;
      rules[t] = { ...rules[t], ...(rule as Partial<TypeRedactionRule>) };
    }
  }
  return { ...DEFAULT_REDACTION_POLICY, ...overrides, rules };
}

/** Guard helper for defense-in-depth checks elsewhere. */
export function isHighIdentity(type: SensitiveType): boolean {
  return HIGH_IDENTITY.has(type);
}

export function isContactType(type: SensitiveType): boolean {
  return CONTACT.has(type);
}
