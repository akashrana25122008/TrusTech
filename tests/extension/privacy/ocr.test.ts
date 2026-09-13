import { describe, it, expect } from "vitest";
import { ocrWordToRegions, ocrToCandidateRegions, type OcrProvider, type OcrWord } from "@/privacy/ocr";
import type { OcRasterScale } from "@/privacy/coords";
import type { VisionRaster } from "@/vision/types";
import type { RegionSize } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * ocr.test.ts — the OCR seam. No runtime is bundled (PaddleOCR deferred),
 * so this proves the seam: OCR words are run through the SAME existing
 * PII engine (provenance "ocr") and mapped into canonical candidate
 * regions. A scripted provider stands in for the runtime.
 * ------------------------------------------------------------------ */

const image: RegionSize = { width: 640, height: 400 };
const scale: OcRasterScale = { ocr: { width: 320, height: 200 }, image };

const raster: VisionRaster = { width: 320, height: 200, data: new Uint8ClampedArray(320 * 200 * 4) };

function makeWord(text: string, bbox: OcrWord["bbox"], confidence = 0.92): OcrWord {
  return { text, confidence, bbox };
}

describe("ocr.ts", () => {
  /* ---- ocrWordToRegions ---- */
  describe("ocrWordToRegions", () => {
    it("detects a valid Aadhaar word and scales its box into image space", async () => {
      const word = makeWord("234567890124", { x: 10, y: 20, width: 200, height: 30 });
      const regions = await ocrWordToRegions(word, scale);
      // sx = sy = 2 → image box = (20, 40, 400, 60)
      expect(regions).toHaveLength(1);
      expect(regions[0].type).toBe("AADHAAR");
      expect(regions[0].source).toBe("ocr");
      expect(regions[0].bbox).toEqual({ x: 20, y: 40, width: 400, height: 60 });
    });

    it("detects an email word", async () => {
      const word = makeWord("buyer@example.com", { x: 0, y: 0, width: 200, height: 20 });
      const regions = await ocrWordToRegions(word, scale);
      expect(regions.map((r) => r.type)).toContain("EMAIL");
    });

    it("rejects masked/partial numbers (no PII pattern → no region)", async () => {
      const word = makeWord("XXXX XXXX 1234", { x: 0, y: 0, width: 100, height: 20 });
      expect(await ocrWordToRegions(word, scale)).toEqual([]);
    });

    it("combines OCR word confidence with detector confidence (noisy-OR, capped)", async () => {
      // word = 0.92, aadhaar finding = 0.95 → combined = 1-(1-0.85*0.92)(1-1.0*0.95)
      // = 1-(0.218*0.05) = 0.9891 → 0.99 (capped)
      const word = makeWord("234567890124", { x: 0, y: 0, width: 200, height: 30 }, 0.92);
      const regions = await ocrWordToRegions(word, scale);
      expect(regions[0].confidence).toBe(0.99);
    });

    it("masks pattern: indicates the evidence is OCR-backed", async () => {
      const word = makeWord("ABCAP1234F", { x: 5, y: 5, width: 100, height: 20 });
      const regions = await ocrWordToRegions(word, scale);
      expect(regions[0].detector).toContain("ocr");
      expect(regions[0].coordinateSystem).toBe("image");
    });
  });

  /* ---- ocrToCandidateRegions ---- */
  describe("ocrToCandidateRegions", () => {
    it("runs provider output through the pipeline with result metrics", async () => {
      const provider: OcrProvider = {
        name: "scripted",
        async extract() {
          return {
            words: [
              makeWord("Reach me", { x: 0, y: 0, width: 80, height: 20 }),
              makeWord("+91 98765 43210", { x: 85, y: 0, width: 150, height: 20 }),
            ],
          };
        },
      };
      const regions = await ocrToCandidateRegions(provider, raster, image);
      const types = regions.map((r) => r.type);
      expect(types).toContain("PHONE");
      // 'Reach me' has no PII → not a region
      expect(regions.find((r) => r.detector?.includes("Reach"))).toBeUndefined();
    });

    it("handles empty provider output", async () => {
      const provider: OcrProvider = {
        name: "empty",
        async extract() {
          return { words: [] };
        },
      };
      expect(await ocrToCandidateRegions(provider, raster, image)).toEqual([]);
    });

    it("skips blank words", async () => {
      const provider: OcrProvider = {
        name: "blank-words",
        async extract() {
          return { words: [makeWord("   ", { x: 0, y: 0, width: 10, height: 10 })] };
        },
      };
      expect(await ocrToCandidateRegions(provider, raster, image)).toEqual([]);
    });
  });
});