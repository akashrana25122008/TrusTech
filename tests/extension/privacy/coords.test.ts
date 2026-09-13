import { describe, it, expect } from "vitest";
import {
  iouRect,
  regionsAligned,
  viewportToImage,
  imageToViewport,
  ocrToImage,
  normalizeBBox,
  unionBBox,
  matchesGroundTruth,
  scaledBBox,
} from "@/privacy/coords";
import type { RegionBBox } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * coords.ts — coordinate conversions, IoU, containment, alignment.
 *
 * Canonical system: image (captured screenshot). All paths validated.
 * ------------------------------------------------------------------ */

describe("coords.ts", () => {
  /* ---- iouRect ---- */
  describe("iouRect", () => {
    it("identical boxes → 1", () => {
      const b: RegionBBox = { x: 10, y: 20, width: 50, height: 30 };
      expect(iouRect(b, b)).toBe(1);
    });

    it("disjoint boxes → 0", () => {
      const a: RegionBBox = { x: 0, y: 0, width: 20, height: 20 };
      const b: RegionBBox = { x: 50, y: 50, width: 20, height: 20 };
      expect(iouRect(a, b)).toBe(0);
    });

    it("partial overlap matches expected IoU", () => {
      // a: 10x10 at (0,0), b: 10x10 at (5,5), inter 5x5 = 25, union 100+100-25=175, IoU = 25/175 ≈ 0.142857
      const a: RegionBBox = { x: 0, y: 0, width: 10, height: 10 };
      const b: RegionBBox = { x: 5, y: 5, width: 10, height: 10 };
      expect(iouRect(a, b)).toBeCloseTo(25 / 175, 5);
    });

    it("touching edges (zero intersection) → 0", () => {
      const a: RegionBBox = { x: 0, y: 0, width: 50, height: 50 };
      const b: RegionBBox = { x: 50, y: 0, width: 50, height: 50 };
      expect(iouRect(a, b)).toBe(0);
    });
  });

  /* ---- regionsAligned ---- */
  describe("regionsAligned", () => {
    it("returns true when IoU passes threshold", () => {
      // Same box → IoU = 1
      const b: RegionBBox = { x: 0, y: 0, width: 50, height: 50 };
      expect(regionsAligned(b, b)).toBe(true);
    });

    it("returns true for containment (small box fully inside large)", () => {
      const big: RegionBBox = { x: 0, y: 0, width: 200, height: 200 };
      const small: RegionBBox = { x: 10, y: 10, width: 50, height: 50 };
      // IoU = 2500 / (40000+2500-2500) = 2500/40000 = 0.0625 < 0.3
      // containment = 2500/2500 = 1.0 ≥ 0.6 → aligned
      expect(regionsAligned(big, small)).toBe(true);
      expect(regionsAligned(small, big)).toBe(true); // both directions
    });

    it("returns false for distant non-overlapping boxes", () => {
      const a: RegionBBox = { x: 0, y: 0, width: 10, height: 10 };
      const b: RegionBBox = { x: 100, y: 100, width: 10, height: 10 };
      expect(regionsAligned(a, b)).toBe(false);
    });
  });

  /* ---- viewportToImage / imageToViewport ---- */
  describe("viewportToImage", () => {
    it("scales viewport coords to image coords correctly", () => {
      const viewport: RegionBBox = { x: 10, y: 20, width: 100, height: 50 };
      const scale = { viewport: { width: 320, height: 200 }, image: { width: 640, height: 400 } };
      const img = viewportToImage(viewport, scale);
      // sx = 640/320 = 2, sy = 400/200 = 2
      expect(img.x).toBe(20);   // 10*2
      expect(img.y).toBe(40);   // 20*2
      expect(img.width).toBe(200);  // 100*2
      expect(img.height).toBe(100); // 50*2
    });
  });

  describe("imageToViewport", () => {
    it("inverts viewportToImage", () => {
      const img: RegionBBox = { x: 20, y: 40, width: 200, height: 100 };
      const scale = { viewport: { width: 320, height: 200 }, image: { width: 640, height: 400 } };
      const vp = imageToViewport(img, scale);
      expect(vp.x).toBeCloseTo(10, 5);
      expect(vp.y).toBeCloseTo(20, 5);
      expect(vp.width).toBeCloseTo(100, 5);
      expect(vp.height).toBeCloseTo(50, 5);
    });
  });

  describe("ocrToImage", () => {
    it("scales OCR raster coords to image coords", () => {
      const ocr: RegionBBox = { x: 5, y: 10, width: 50, height: 20 };
      const scale = { ocr: { width: 160, height: 100 }, image: { width: 640, height: 400 } };
      const img = ocrToImage(ocr, scale);
      // sx = 640/160 = 4, sy = 400/100 = 4
      expect(img.x).toBe(20);
      expect(img.y).toBe(40);
      expect(img.width).toBe(200);
      expect(img.height).toBe(80);
    });
  });

  /* ---- scaledBBox ---- */
  describe("scaledBBox", () => {
    it("rounds to 1 decimal place", () => {
      const b: RegionBBox = { x: 3.333, y: 7.777, width: 10.05, height: 20.99 };
      const s = scaledBBox(b, 2, 2);
      expect(s.x).toBe(6.7);   // 3.333*2 = 6.666 → 6.7
      expect(s.y).toBe(15.6);  // 7.777*2 = 15.554 → 15.6
      expect(s.width).toBe(20.1);  // 10.05*2 = 20.10 → 20.1
      expect(s.height).toBe(42);   // 20.99*2 = 41.98 → 42
    });

    it("clamps x/y to never be negative", () => {
      const b: RegionBBox = { x: -10, y: -5, width: 20, height: 20 };
      const s = scaledBBox(b, 1, 1);
      expect(s.x).toBe(0);
      expect(s.y).toBe(0);
    });
  });

  /* ---- normalizeBBox ---- */
  describe("normalizeBBox", () => {
    it("returns 0..1 normalized box", () => {
      const b: RegionBBox = { x: 64, y: 96, width: 320, height: 240 };
      const norm = normalizeBBox(b, { width: 640, height: 480 });
      expect(norm.x).toBeCloseTo(0.1, 5);
      expect(norm.y).toBeCloseTo(0.2, 5);
      expect(norm.width).toBeCloseTo(0.5, 5);
      expect(norm.height).toBeCloseTo(0.5, 5);
    });

    it("handles zero-size image safely (division guard)", () => {
      const b: RegionBBox = { x: 0, y: 0, width: 100, height: 100 };
      const norm = normalizeBBox(b, { width: 0, height: 0 });
      expect(norm.x).toBe(0);
      expect(norm.y).toBe(0);
    });
  });

  /* ---- unionBBox ---- */
  describe("unionBBox", () => {
    it("returns bounding box of both boxes", () => {
      const a: RegionBBox = { x: 10, y: 20, width: 50, height: 30 };
      const b: RegionBBox = { x: 40, y: 10, width: 60, height: 80 };
      const u = unionBBox(a, b);
      expect(u).toEqual({ x: 10, y: 10, width: 90, height: 80 });
    });

    it("same box → itself", () => {
      const b: RegionBBox = { x: 5, y: 5, width: 50, height: 50 };
      expect(unionBBox(b, b)).toEqual(b);
    });
  });

  /* ---- matchesGroundTruth ---- */
  describe("matchesGroundTruth", () => {
    it("returns true for IoU-matching boxes", () => {
      const pred: RegionBBox = { x: 48, y: 92, width: 360, height: 44 };
      const gt: RegionBBox = { x: 48, y: 92, width: 360, height: 44 };
      expect(matchesGroundTruth(pred, gt)).toBe(true);
    });

    it("returns true for containment (small GT in large pred)", () => {
      const pred: RegionBBox = { x: 0, y: 0, width: 640, height: 480 };
      const gt: RegionBBox = { x: 100, y: 100, width: 50, height: 50 };
      // containment = 2500/2500 = 1.0 ≥ 0.6
      expect(matchesGroundTruth(pred, gt)).toBe(true);
    });

    it("returns false for non-aligned boxes", () => {
      const pred: RegionBBox = { x: 0, y: 0, width: 10, height: 10 };
      const gt: RegionBBox = { x: 500, y: 500, width: 10, height: 10 };
      expect(matchesGroundTruth(pred, gt)).toBe(false);
    });
  });
});