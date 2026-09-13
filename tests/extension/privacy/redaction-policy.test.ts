import { describe, it, expect } from "vitest";
import {
  DEFAULT_REDACTION_POLICY,
  configurePolicy,
  isContactType,
  isHighIdentity,
  isRedactionMethod,
  METHOD_STRENGTH,
  REDACTION_METHODS,
  resolveMethod,
  ruleFor,
} from "@/privacy/redaction-policy";

/* Phase 3 §6 + §35 — deterministic method selection, single policy layer. */

describe("redaction-policy.ts", () => {
  it("exposes exactly the closed BLACKOUT/BLUR/MASK union", () => {
    expect([...REDACTION_METHODS].sort()).toEqual(["BLACKOUT", "BLUR", "MASK"]);
    expect(isRedactionMethod("BLACKOUT")).toBe(true);
    expect(isRedactionMethod("BLUR")).toBe(true);
    expect(isRedactionMethod("MASK")).toBe(true);
    expect(isRedactionMethod("blackout")).toBe(false);
    expect(isRedactionMethod("").valueOf()).toBeFalsy();
    expect(isRedactionMethod(undefined)).toBe(false);
    expect(isRedactionMethod(null)).toBe(false);
  });

  it("strength ordering: BLACKOUT > MASK > BLUR", () => {
    expect(METHOD_STRENGTH.BLACKOUT).toBeGreaterThan(METHOD_STRENGTH.MASK);
    expect(METHOD_STRENGTH.MASK).toBeGreaterThan(METHOD_STRENGTH.BLUR);
  });

  it("HIGH identity numbers resolve to BLACKOUT", () => {
    for (const t of ["PASSWORD", "CARD_NUMBER", "AADHAAR", "PAN", "SSN", "PASSPORT", "VOTER_ID", "DRIVING_LICENSE"] as const) {
      expect(resolveMethod(t, "high", 0.95)).toBe("BLACKOUT");
      expect(isHighIdentity(t)).toBe(true);
    }
  });

  it("FACE resolves to BLUR (documented policy choice)", () => {
    expect(resolveMethod("FACE", "high", 0.9)).toBe("BLUR");
    expect(resolveMethod("FACE", "medium", 0.7)).toBe("BLUR");
  });

  it("contact identifiers resolve to MASK", () => {
    for (const t of ["UPI", "IFSC", "PHONE", "EMAIL"] as const) {
      expect(resolveMethod(t, "medium", 0.85)).toBe("MASK");
      expect(isContactType(t)).toBe(true);
    }
  });

  it("below-min-confidence regions are skipped (null)", () => {
    expect(resolveMethod("AADHAAR", "high", 0.4)).toBeNull();
    expect(resolveMethod("EMAIL", "medium", 0.1)).toBeNull();
  });

  it("a custom policy mapping HIGH identity to BLUR is upgraded (insecure combo blocked)", () => {
    const weak = configurePolicy({ rules: { AADHAAR: { method: "BLUR" } } });
    expect(resolveMethod("AADHAAR", "high", 0.95, weak)).toBe("BLACKOUT");
  });

  it("a custom policy mapping HIGH contact info to BLUR is raised to at least MASK", () => {
    const weak = configurePolicy({ rules: { PHONE: { method: "BLUR", minimumMethod: "BLUR" } } });
    expect(resolveMethod("PHONE", "high", 0.9, weak)).toBe("MASK");
  });

  it("deterministic: same inputs always give the same method", () => {
    const a = resolveMethod("PAN", "high", 0.92);
    for (let i = 0; i < 5; i++) expect(resolveMethod("PAN", "high", 0.92)).toBe(a);
  });

  it("default paddings balance safety vs context", () => {
    expect(ruleFor("FACE").padding).toBeGreaterThanOrEqual(ruleFor("EMAIL").padding);
    expect(ruleFor("PASSWORD").padding).toBeGreaterThan(0);
    for (const t of Object.keys(DEFAULT_REDACTION_POLICY.rules)) {
      expect(ruleFor(t as Parameters<typeof ruleFor>[0]).padding).toBeGreaterThanOrEqual(0);
    }
  });

  it("configurePolicy merges overrides without touching other rules", () => {
    const custom = configurePolicy({ blurRadius: 20, rules: { FACE: { padding: 4 } } });
    expect(custom.blurRadius).toBe(20);
    expect(custom.rules.FACE.padding).toBe(4);
    expect(custom.rules.FACE.method).toBe("BLUR");
    expect(custom.rules.PAN.method).toBe("BLACKOUT");
    expect(DEFAULT_REDACTION_POLICY.blurRadius).toBe(12); // default untouched
  });
});
