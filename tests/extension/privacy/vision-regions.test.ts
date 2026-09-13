import { describe, it, expect } from "vitest";
import { visionDetectionType, visionDetectionsToRegions } from "@/privacy/vision-regions";
import type { VisionDetection } from "@/vision/types";
import type { RegionSize } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * vision-regions.ts — VisionDetection → SensitiveRegion candidate mapping.
 *
 * Only detection.type === "face" maps to FACE; every other COCO class
 * is treated as layout/context and is NEVER promoted to a canonical
 * SensitiveRegion. This module is a pure, deterministic map.
 * ------------------------------------------------------------------ */

describe("vision-regions.ts", () => {
  const image: RegionSize = { width: 640, height: 480 };

  /* ---- visionDetectionType ---- */
  describe("visionDetectionType", () => {
    it("maps 'face' → FACE", () => {
      const det: VisionDetection = {
        type: "face",
        label: "person",
        confidence: 0.88,
        bbox: { x: 0, y: 0, width: 100, height: 100 },
      };
      expect(visionDetectionType(det)).toBe("FACE");
    });

    it("all other types map to null (layout/context only)", () => {
      const types: VisionDetection["type"][] = ["element", "text", "sensitive", "face"];
      for (const type of types) {
        const det: VisionDetection = {
          type,
          label: type,
          confidence: 0.8,
          bbox: { x: 0, y: 0, width: 100, height: 100 },
        };
        expect(visionDetectionType(det)).toBe(type === "face" ? "FACE" : null);
      }
    });
  });

  /* ---- visionDetectionsToRegions ---- */
  describe("visionDetectionsToRegions", () => {
    it("returns empty array for null/undefined", () => {
      expect(visionDetectionsToRegions(null, image)).toEqual([]);
      expect(visionDetectionsToRegions(undefined, image)).toEqual([]);
    });

    it("filters out non-face detections", () => {
      const dets: VisionDetection[] = [
        { type: "element", label: "tv", confidence: 0.9, bbox: { x: 0, y: 0, width: 200, height: 150 } },
        { type: "text", label: "text", confidence: 0.7, bbox: { x: 10, y: 10, width: 50, height: 20 } },
      ];
      expect(visionDetectionsToRegions(dets, image)).toEqual([]);
    });

    it("returns a FACE region for a face detection", () => {
      const dets: VisionDetection[] = [
        { type: "face", label: "person", confidence: 0.85, bbox: { x: 100, y: 50, width: 120, height: 140 } },
      ];
      const regions = visionDetectionsToRegions(dets, image);
      expect(regions).toHaveLength(1);
      expect(regions[0].type).toBe("FACE");
      expect(regions[0].confidence).toBe(0.85);
      expect(regions[0].source).toBe("vision");
      expect(regions[0].bbox.x).toBe(100);
      expect(regions[0].bbox.y).toBe(50);
      expect(regions[0].bbox.width).toBe(120);
      expect(regions[0].bbox.height).toBe(140);
    });

    it("clamps boxes that extend outside image bounds", () => {
      const dets: VisionDetection[] = [
        { type: "face", label: "person", confidence: 0.8, bbox: { x: 600, y: 400, width: 200, height: 200 } },
      ];
      const regions = visionDetectionsToRegions(dets, image);
      expect(regions).toHaveLength(1);
      expect(regions[0].bbox.x).toBe(600);
      expect(regions[0].bbox.y).toBe(400);
      // width clamped: max(0, min(200, image.width - 600)) = max(0, min(200, 40)) = 40
      expect(regions[0].bbox.width).toBe(40);
      // height clamped: max(0, min(200, 480-400)) = 80
      expect(regions[0].bbox.height).toBe(80);
    });

    it("filters out detections below minConfidence", () => {
      const dets: VisionDetection[] = [
        { type: "face", label: "person", confidence: 0.3, bbox: { x: 0, y: 0, width: 50, height: 50 } },
      ];
      expect(visionDetectionsToRegions(dets, image, 0.5)).toEqual([]);
    });

    it("sets coordinateSystem to 'image'", () => {
      const dets: VisionDetection[] = [
        { type: "face", label: "person", confidence: 0.9, bbox: { x: 0, y: 0, width: 50, height: 50 } },
      ];
      const regions = visionDetectionsToRegions(dets, image);
      expect(regions[0].coordinateSystem).toBe("image");
    });

    it("sets detector to 'yolos-tiny'", () => {
      const dets: VisionDetection[] = [
        { type: "face", label: "person", confidence: 0.9, bbox: { x: 0, y: 0, width: 50, height: 50 } },
      ];
      const regions = visionDetectionsToRegions(dets, image);
      expect(regions[0].detector).toBe("yolos-tiny");
    });
  });
});