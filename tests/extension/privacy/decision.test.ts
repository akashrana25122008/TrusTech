import { describe, it, expect } from "vitest";
import { decidePrivacy } from "@/privacy/decision";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * decision.ts — SAFE / SCANNING / ALERT, action mapping, evidence brief.
 * ------------------------------------------------------------------ */

function region(partial: Partial<SensitiveRegion>): SensitiveRegion {
  const base = {
    type: "AADHAAR" as const,
    bbox: { x: 0, y: 0, width: 100, height: 40 },
    confidence: 0.95,
    severity: "high" as const,
    source: "text" as const,
    sources: ["text"] as const,
    evidence: [],
    image: { width: 640, height: 480 },
    normalized: { x: 0, y: 0, width: 100 / 640, height: 40 / 480 },
  };
  return { ...base, ...partial } as SensitiveRegion;
}

describe("decision.ts", () => {
  it("no regions → SAFE / none", () => {
    const d = decidePrivacy([]);
    expect(d.verdict).toBe("SAFE");
    expect(d.action).toBe("none");
    expect(d.sensitivePresent).toBe(false);
    expect(d.regionCount).toBe(0);
    expect(d.types).toEqual([]);
    expect(d.evidenceBrief).not.toContain("AADHAAR");
  });

  it("medium-severity region → SCANNING / sanitize (no hard block on contact info)", () => {
    const d = decidePrivacy([
      region({ type: "EMAIL", confidence: 0.85, severity: "medium" }),
    ]);
    expect(d.verdict).toBe("SCANNING");
    expect(d.action).toBe("sanitize");
    expect(d.maxSeverity).toBe("medium");
    expect(d.types).toContain("EMAIL");
    expect(d.urgent).not.toContain("EMAIL");
  });

  it("HIGH-severity region → ALERT / block (respects default hardBlock)", () => {
    const d = decidePrivacy([region({ type: "AADHAAR", confidence: 0.95, severity: "high" })]);
    expect(d.verdict).toBe("ALERT");
    expect(d.action).toBe("block");
    expect(d.maxSeverity).toBe("high");
    expect(d.urgent).toContain("AADHAAR");
  });

  it("hardBlock:false → SCANNING (sanitize) even for HIGH severity", () => {
    const d = decidePrivacy([region({ type: "PAN", confidence: 0.92, severity: "high" })], { hardBlock: false });
    expect(d.verdict).toBe("SCANNING");
    expect(d.action).toBe("sanitize");
  });

  it("several high regions → aggregate report", () => {
    const d = decidePrivacy([
      region({ type: "AADHAAR", confidence: 0.95, severity: "high" }),
      region({ type: "PAN", confidence: 0.92, severity: "high", bbox: { x: 40, y: 40, width: 40, height: 40 } }),
    ]);
    expect(d.verdict).toBe("ALERT");
    expect(d.regionCount).toBe(2);
    expect(d.types).toContain("AADHAAR");
    expect(d.types).toContain("PAN");
    expect(d.maxConfidence).toBe(0.95);
  });

  it("evidenceBrief includes type counts and sources, never raw values", () => {
    const d = decidePrivacy([region({ type: "PAN", confidence: 0.92, severity: "high" })]);
    expect(d.evidenceBrief).toContain("PAN(1) via text");
    expect(d.evidenceBrief).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
  });

  it("multi-source region lists all sources in brief", () => {
    const d = decidePrivacy([
      region({
        type: "CARD_NUMBER",
        sources: ["dom", "ocr"],
        source: "dom",
        severity: "high",
      }),
    ]);
    expect(d.evidenceBrief).toMatch(/dom\+ocr/);
  });
});