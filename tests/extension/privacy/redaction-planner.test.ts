import { describe, it, expect } from "vitest";
import { planRedactions } from "@/privacy/redaction-planner";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 3 §5 + §10 + §11 + §12 — planner: filter/pad/clamp/merge/ids. */

function region(partial: Partial<SensitiveRegion>): SensitiveRegion {
  return {
    type: "AADHAAR",
    bbox: { x: 100, y: 100, width: 200, height: 40 },
    confidence: 0.95,
    severity: "high",
    source: "text",
    sources: ["text"],
    evidence: [],
    image: { width: 640, height: 480 },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
    ...partial,
  } as SensitiveRegion;
}

const IMAGE = { width: 640, height: 480 };

describe("redaction-planner.ts", () => {
  it("plans a padded, clamped BLACKOUT op for a HIGH identity region", () => {
    const { operations, dropped } = planRedactions([region({})], IMAGE);
    expect(dropped).toEqual([]);
    expect(operations).toHaveLength(1);
    const [op] = operations;
    expect(op.id).toBe("r1");
    expect(op.type).toBe("AADHAAR");
    expect(op.method).toBe("BLACKOUT");
    // padding 8 → [92, 92, 216, 56]
    expect(op.bbox).toEqual([92, 92, 216, 56]);
  });

  it("assigns deterministic ids in strength→severity→confidence order", () => {
    const { operations } = planRedactions(
      [
        region({ type: "EMAIL", bbox: { x: 0, y: 0, width: 60, height: 20 }, confidence: 0.85, severity: "medium" }),
        region({ type: "FACE", bbox: { x: 400, y: 300, width: 80, height: 80 }, confidence: 0.9, severity: "high" }),
        region({}),
      ],
      IMAGE,
    );
    expect(operations.map((o) => o.id)).toEqual(["r1", "r2", "r3"]);
    expect(operations[0].type).toBe("AADHAAR"); // BLACKOUT first
    expect(operations[1].type).toBe("EMAIL"); // MASK before BLUR
    expect(operations[2].type).toBe("FACE");
  });

  it("clamps out-of-bounds boxes into image pixels", () => {
    const { operations, dropped } = planRedactions(
      [region({ bbox: { x: 600, y: 450, width: 200, height: 100 } })],
      IMAGE,
    );
    expect(dropped).toEqual([]);
    expect(operations[0].bbox[0]).toBeGreaterThanOrEqual(0);
    expect(operations[0].bbox[1]).toBeGreaterThanOrEqual(0);
    expect(operations[0].bbox[0] + operations[0].bbox[2]).toBeLessThanOrEqual(640);
    expect(operations[0].bbox[1] + operations[0].bbox[3]).toBeLessThanOrEqual(480);
  });

  it("drops fully out-of-frame regions with a recorded reason", () => {
    const { operations, dropped } = planRedactions(
      [region({ bbox: { x: 900, y: 900, width: 50, height: 50 } })],
      IMAGE,
    );
    expect(operations).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe("out-of-frame");
  });

  it("drops below-confidence regions with a recorded reason", () => {
    const { operations, dropped } = planRedactions([region({ confidence: 0.2 })], IMAGE);
    expect(operations).toEqual([]);
    expect(dropped[0].reason).toBe("below-confidence");
  });

  it("merges overlapping ops into the union with the stronger method", () => {
    const { operations } = planRedactions(
      [
        region({ type: "EMAIL", bbox: { x: 100, y: 100, width: 120, height: 40 }, confidence: 0.85, severity: "medium" }),
        region({ type: "PHONE", bbox: { x: 150, y: 110, width: 120, height: 40 }, confidence: 0.9, severity: "medium" }),
      ],
      IMAGE,
    );
    expect(operations).toHaveLength(1);
    const [op] = operations;
    // union of padded boxes: EMAIL padded 6 → [94,94,132,52]; PHONE → [144,104,132,52]
    // union → [94,94,182,62]
    expect(op.bbox).toEqual([94, 94, 182, 62]);
    expect(op.method).toBe("MASK");
    expect(op.mergedTypes.sort()).toEqual(["EMAIL", "PHONE"]);
  });

  it("stronger method wins on cross-method overlap (BLACKOUT over BLUR)", () => {
    const { operations } = planRedactions(
      [
        region({ type: "FACE", bbox: { x: 100, y: 100, width: 80, height: 80 }, confidence: 0.9, severity: "high" }),
        region({ type: "AADHAAR", bbox: { x: 120, y: 120, width: 100, height: 40 }, confidence: 0.95, severity: "high" }),
      ],
      IMAGE,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0].method).toBe("BLACKOUT");
    expect(operations[0].type).toBe("AADHAAR");
    expect(operations[0].mergedTypes.sort()).toEqual(["AADHAAR", "FACE"]);
  });

  it("keeps disjoint regions as separate operations", () => {
    const { operations } = planRedactions(
      [
        region({}),
        region({ type: "PAN", bbox: { x: 400, y: 300, width: 120, height: 30 }, confidence: 0.92, severity: "high" }),
      ],
      IMAGE,
    );
    expect(operations).toHaveLength(2);
  });

  it("empty input yields empty plan (verified-clean path)", () => {
    const { operations, dropped } = planRedactions([], IMAGE);
    expect(operations).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("all bboxes are integers within the frame", () => {
    const { operations } = planRedactions(
      [region({ bbox: { x: 10.7, y: 20.3, width: 99.9, height: 40.2 } })],
      IMAGE,
    );
    for (const n of operations[0].bbox) expect(Number.isInteger(n)).toBe(true);
  });
});
