import { describe, it, expect } from "vitest";
import {
  severityFor,
  baseSeverityFor,
  typePriority,
  patternNameFor,
  findingToSensitive,
  SOURCE_RELIABILITY,
  MIN_REGION_CONFIDENCE,
  STRONG_CONFIDENCE,
  MAX_FUSED_CONFIDENCE,
} from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * regions.ts — canonical contracts, severity model, type mapping.
 *
 * All rules are pure → fully deterministic, no runtime side-effects.
 * ------------------------------------------------------------------ */

describe("regions.ts", () => {
  describe("confidence thresholds", () => {
    it("MIN_REGION_CONFIDENCE < STRONG_CONFIDENCE < MAX_FUSED_CONFIDENCE", () => {
      expect(MIN_REGION_CONFIDENCE).toBeLessThan(STRONG_CONFIDENCE);
      expect(STRONG_CONFIDENCE).toBeLessThan(MAX_FUSED_CONFIDENCE);
      expect(MIN_REGION_CONFIDENCE).toBeGreaterThanOrEqual(0.5);
      expect(MIN_REGION_CONFIDENCE).toBeLessThanOrEqual(0.55);
      expect(STRONG_CONFIDENCE).toBeGreaterThanOrEqual(0.64);
      expect(STRONG_CONFIDENCE).toBeLessThanOrEqual(0.66);
      expect(MAX_FUSED_CONFIDENCE).toBeLessThanOrEqual(1);
    });

    it("SOURCE_RELIABILITY weights are sensible", () => {
      expect(SOURCE_RELIABILITY.dom).toBe(1);
      expect(SOURCE_RELIABILITY.text).toBe(1);
      expect(SOURCE_RELIABILITY.vision).toBe(0.9);
      expect(SOURCE_RELIABILITY.ocr).toBe(0.85);
    });
  });

  describe("severityFor", () => {
    it("HIGH types at strong confidence → high", () => {
      expect(severityFor("FACE", 0.85)).toBe("high");
      expect(severityFor("PASSWORD", 0.96)).toBe("high");
      expect(severityFor("AADHAAR", 0.95)).toBe("high");
      expect(severityFor("CARD_NUMBER", 0.9)).toBe("high");
    });

    it("HIGH types at confidence above MIN but below STRONG → one level softer (medium)", () => {
      expect(severityFor("FACE", 0.6)).toBe("medium");
      expect(severityFor("PASSWORD", 0.62)).toBe("medium");
      expect(severityFor("AADHAAR", 0.56)).toBe("medium");
    });

    it("HIGH types at exactly MIN_REGION_CONFIDENCE → low", () => {
      expect(severityFor("FACE", 0.5)).toBe("low");
      expect(severityFor("PASSWORD", 0.5)).toBe("low");
    });

    it("MEDIUM types at strong → medium", () => {
      expect(severityFor("EMAIL", 0.85)).toBe("medium");
      expect(severityFor("PHONE", 0.9)).toBe("medium");
      expect(severityFor("UPI", 0.8)).toBe("medium");
      expect(severityFor("IFSC", 0.9)).toBe("medium");
    });

    it("MEDIUM types below STRONG but above MIN → low", () => {
      expect(severityFor("EMAIL", 0.62)).toBe("low");
      expect(severityFor("PHONE", 0.56)).toBe("low");
    });

    it("MEDIUM at MIN → low", () => {
      expect(severityFor("EMAIL", 0.5)).toBe("low");
    });

    it("baseSeverityFor", () => {
      expect(baseSeverityFor("FACE")).toBe("high");
      expect(baseSeverityFor("AADHAAR")).toBe("high");
      expect(baseSeverityFor("CARD_NUMBER")).toBe("high");
      expect(baseSeverityFor("EMAIL")).toBe("medium");
      expect(baseSeverityFor("PHONE")).toBe("medium");
      expect(baseSeverityFor("IFSC")).toBe("medium");
      expect(baseSeverityFor("UPI")).toBe("medium");
      expect(baseSeverityFor("SSN")).toBe("high");
    });
  });

  describe("typePriority tie-break", () => {
    it("AADHAAR > PAN > CARD_NUMBER > IFSC > PHONE > EMAIL", () => {
      expect(typePriority("AADHAAR")).toBeGreaterThan(typePriority("PAN"));
      expect(typePriority("PAN")).toBeGreaterThan(typePriority("CARD_NUMBER"));
      expect(typePriority("CARD_NUMBER")).toBeGreaterThan(typePriority("IFSC"));
      expect(typePriority("IFSC")).toBeGreaterThan(typePriority("PHONE"));
      expect(typePriority("PHONE")).toBeGreaterThan(typePriority("EMAIL"));
    });

    it("PASSWORD is above FACE and UPI", () => {
      expect(typePriority("PASSWORD")).toBeGreaterThan(typePriority("FACE"));
      expect(typePriority("PASSWORD")).toBeGreaterThan(typePriority("UPI"));
    });

    it("all 13 types have explicit priority", () => {
      const types = [
        "FACE","PASSWORD","CARD_NUMBER","AADHAAR","PAN","SSN",
        "PASSPORT","DRIVING_LICENSE","VOTER_ID","UPI","IFSC","PHONE","EMAIL",
      ] as const;
      for (const t of types) {
        expect(typePriority(t)).toBeGreaterThan(0);
      }
    });
  });

  describe("findingToSensitive", () => {
    it("maps all FindingTypes to the correct canonical type", () => {
      expect(findingToSensitive("aadhaar")).toBe("AADHAAR");
      expect(findingToSensitive("pan")).toBe("PAN");
      expect(findingToSensitive("credit_card")).toBe("CARD_NUMBER");
      expect(findingToSensitive("email")).toBe("EMAIL");
      expect(findingToSensitive("phone")).toBe("PHONE");
      expect(findingToSensitive("upi")).toBe("UPI");
      expect(findingToSensitive("ifsc")).toBe("IFSC");
      expect(findingToSensitive("passport")).toBe("PASSPORT");
      expect(findingToSensitive("voter_id")).toBe("VOTER_ID");
      expect(findingToSensitive("driving_licence")).toBe("DRIVING_LICENSE");
      expect(findingToSensitive("ssn")).toBe("SSN");
    });

    it("ipv4 and postal → null (not canonical sensitive types)", () => {
      expect(findingToSensitive("ipv4")).toBeNull();
      expect(findingToSensitive("postal")).toBeNull();
    });
  });

  describe("patternNameFor", () => {
    it("covers all SensitiveType values", () => {
      const types = [
        "FACE","PASSWORD","CARD_NUMBER","AADHAAR","PAN","SSN",
        "PASSPORT","DRIVING_LICENSE","VOTER_ID","UPI","IFSC","PHONE","EMAIL",
      ] as const;
      for (const t of types) {
        expect(patternNameFor(t)).toBeTruthy();
        expect(typeof patternNameFor(t)).toBe("string");
      }
    });

    it("uses the correct detector labels", () => {
      expect(patternNameFor("FACE")).toBe("vision:coco-person");
      expect(patternNameFor("PASSWORD")).toBe("dom:input-password");
      expect(patternNameFor("AADHAAR")).toBe("text:aadhaar-verhoeff");
      expect(patternNameFor("PAN")).toBe("text:pan");
      expect(patternNameFor("EMAIL")).toBe("text:email");
    });
  });
});