import { describe, it, expect } from "vitest";
import { fuseConfidence, fuseRegionList, fuseSensitiveRegions, type CandidateRegion } from "@/privacy/region-fusion";
import { MAX_FUSED_CONFIDENCE, type RegionSize } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * region-fusion.test.ts — overlap merge, confidence combos, conflicts,
 * independent-text rule, dedup, deterministic ordering/finalize.
 * ------------------------------------------------------------------ */

const image: RegionSize = { width: 640, height: 480 };

function cand(partial: Partial<CandidateRegion>): CandidateRegion {
  return {
    type: "AADHAAR",
    bbox: { x: 0, y: 0, width: 200, height: 40 },
    confidence: 0.9,
    source: "text",
    detector: "text:aadhaar-verhoeff",
    coordinateSystem: "image",
    ...partial,
  };
}

describe("fuseConfidence", () => {
  it("single source respects source reliability", () => {
    expect(fuseConfidence([{ source: "dom", confidence: 0.9 }])).toBe(0.9);
    expect(fuseConfidence([{ source: "vision", confidence: 0.8 }])).toBeCloseTo(0.72, 2);
    // 0.85 * 0.9 = 0.765, rounded to 2dp by the engine → 0.77
    expect(fuseConfidence([{ source: "ocr", confidence: 0.9 }])).toBe(0.77);
  });

  it("two corroborating sources raise confidence above each single one", () => {
    const single = fuseConfidence([{ source: "vision", confidence: 0.8 }]);
    const pair = fuseConfidence([
      { source: "vision", confidence: 0.8 },
      { source: "text", confidence: 0.8 },
    ]);
    expect(pair).toBeGreaterThan(single);
  });

  it("caps at MAX_FUSED_CONFIDENCE", () => {
    const out = fuseConfidence([
      { source: "dom", confidence: 0.99 },
      { source: "text", confidence: 0.99 },
      { source: "vision", confidence: 0.99 },
    ]);
    expect(out).toBeLessThanOrEqual(MAX_FUSED_CONFIDENCE);
  });

  it("ignores out-of-range confidence (clamped 0..1)", () => {
    const out = fuseConfidence([{ source: "text", confidence: 3 }]);
    expect(out).toBeLessThanOrEqual(MAX_FUSED_CONFIDENCE);
  });
});

describe("fuseRegionList", () => {
  /* ---- merging ---- */
  it("merges same-type overlapping candidates into one region with combined confidence", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "AADHAAR", bbox: { x: 0, y: 0, width: 200, height: 40 }, confidence: 0.8, source: "text" }),
        cand({ type: "AADHAAR", bbox: { x: 20, y: 5, width: 200, height: 40 }, confidence: 0.9, source: "dom" }),
      ],
      image,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].sources).toContain("text");
    expect(regions[0].sources).toContain("dom");
    expect(regions[0].confidence).toBeGreaterThan(0.9); // noisy-OR over both
    expect(regions[0].severity).toBe("high");
  });

  it("does not merge far-apart same-type candidates", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "AADHAAR", bbox: { x: 0, y: 0, width: 50, height: 20 }, confidence: 0.8, source: "text" }),
        cand({ type: "AADHAAR", bbox: { x: 500, y: 300, width: 50, height: 20 }, confidence: 0.8, source: "dom" }),
      ],
      image,
    );
    expect(regions).toHaveLength(2);
  });

  /* ---- filtering ---- */
  it("drops candidates below MIN_REGION_CONFIDENCE", () => {
    const regions = fuseRegionList([cand({ confidence: 0.4 })], image);
    expect(regions).toHaveLength(0);
  });

  /* ---- conflicts ------------------------------------------------------------------ ---- */
  it("strong beats weak for overlapping different types", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "FACE", bbox: { x: 0, y: 0, width: 100, height: 100 }, confidence: 0.72, source: "vision" }),
        cand({ type: "EMAIL", bbox: { x: 10, y: 10, width: 80, height: 80 }, confidence: 0.58, source: "text" }),
      ],
      image,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("FACE");
  });

  it("weak never overwrites strong", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "EMAIL", bbox: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.85, source: "text" }),
        cand({ type: "FACE", bbox: { x: 10, y: 5, width: 80, height: 40 }, confidence: 0.6, source: "vision" }),
      ],
      image,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("EMAIL");
  });

  it("strong vs strong → higher confidence wins and conflict uncertainty is recorded", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "PAN", bbox: { x: 0, y: 0, width: 120, height: 40 }, confidence: 0.9, source: "text" }),
        cand({ type: "PHONE", bbox: { x: 5, y: 5, width: 110, height: 35 }, confidence: 0.92, source: "dom" }),
      ],
      image,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("PHONE");
    // Uncertainty recorded on winner.
    expect(regions[0].evidence.some((e) => e.detector === "conflict:PAN")).toBe(true);
  });

  it("equal confidence → higher type priority wins the conflict", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "PAN", bbox: { x: 0, y: 0, width: 120, height: 40 }, confidence: 0.9, source: "text" }),
        cand({ type: "UPI", bbox: { x: 5, y: 5, width: 110, height: 35 }, confidence: 0.9, source: "dom" }),
      ],
      image,
    );
    // PAN priority 95 > UPI 65 → PAN wins (equal strength, equal confidence)
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("PAN");
  });

  /* ---- independent text rule ---- */
  it("text candidates of DIFFERENT types at the same box never conflict (all kept)", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "EMAIL", bbox: { x: 0, y: 0, width: 300, height: 30 }, confidence: 0.85, source: "text" }),
        cand({ type: "PHONE", bbox: { x: 0, y: 0, width: 300, height: 30 }, confidence: 0.9, source: "text" }),
        cand({ type: "UPI", bbox: { x: 0, y: 0, width: 300, height: 30 }, confidence: 0.8, source: "text" }),
      ],
      image,
    );
    const types = regions.map((r) => r.type).sort();
    expect(types).toEqual(["EMAIL", "PHONE", "UPI"]);
  });

  /* ---- dedup / finalize ---- */
  it("produces normalized and severity-complete regions", () => {
    const regions = fuseRegionList([cand({ type: "AADHAAR", confidence: 0.95 })], image);
    expect(regions[0].severity).toBe("high");
    expect(regions[0].normalized.x).toBeCloseTo(0, 5);
    expect(regions[0].normalized.width).toBeCloseTo(200 / 640, 5);
    expect(regions[0].source).toBe("text");
    expect(regions[0].sources).toEqual(["text"]);
    expect(regions[0].image).toEqual(image);
  });

  it("orders output by severity desc then confidence desc", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "EMAIL", bbox: { x: 0, y: 300, width: 60, height: 20 }, confidence: 0.85, source: "text" }),
        cand({ type: "AADHAAR", bbox: { x: 0, y: 0, width: 200, height: 40 }, confidence: 0.95, source: "text" }),
        cand({ type: "PHONE", bbox: { x: 0, y: 100, width: 90, height: 20 }, confidence: 0.9, source: "dom" }),
      ],
      image,
    );
    expect(regions.map((r) => r.type)).toEqual(["AADHAAR", "PHONE", "EMAIL"]);
  });

  it("dedups source list when one source contributes multiple times", () => {
    const regions = fuseRegionList(
      [
        cand({ type: "FACE", confidence: 0.8, source: "vision" }),
        cand({ type: "FACE", bbox: { x: 20, y: 5, width: 100, height: 40 }, confidence: 0.7, source: "vision" }),
      ],
      image,
    );
    expect(regions[0].sources).toEqual(["vision"]);
  });
});

/* ---- fuseSensitiveRegions (spec API) ---- */
describe("fuseSensitiveRegions", () => {
  it("combines vision + dom + ocr + text into one list and dedups same-type", () => {
    const face: CandidateRegion = {
      type: "FACE",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      confidence: 0.85,
      source: "vision",
      detector: "yolos-tiny",
      coordinateSystem: "image",
    };
    const pwd: CandidateRegion = {
      type: "PASSWORD",
      bbox: { x: 200, y: 50, width: 120, height: 40 },
      confidence: 0.96,
      source: "dom",
      detector: "dom:input-password",
      coordinateSystem: "image",
    };
    const aadhaar: CandidateRegion = {
      type: "AADHAAR",
      bbox: { x: 400, y: 50, width: 200, height: 40 },
      confidence: 0.95,
      source: "text",
      detector: "text:aadhaar-verhoeff",
      coordinateSystem: "image",
    };
    const redundantAadhaar: CandidateRegion = {
      ...aadhaar,
      bbox: { x: 410, y: 55, width: 190, height: 35 },
      confidence: 0.8,
      source: "ocr",
      detector: "ocr",
      coordinateSystem: "image",
    };

    const regions = fuseSensitiveRegions({
      visionRegions: [face],
      domRegions: [pwd],
      textRegions: [aadhaar],
      ocrRegions: [redundantAadhaar],
      image,
    });

    const types = regions.map((r) => r.type);
    expect(types).toContain("FACE");
    expect(types).toContain("PASSWORD");
    // aadhaar merged with its OCR twin → single AADHAAR region + corroborating sources
    const aadhaars = regions.filter((r) => r.type === "AADHAAR");
    expect(aadhaars).toHaveLength(1);
    expect(aadhaars[0].sources).toContain("text");
    expect(aadhaars[0].sources).toContain("ocr");
  });

  it("empty input → empty output", () => {
    expect(fuseSensitiveRegions({ image })).toEqual([]);
  });
});