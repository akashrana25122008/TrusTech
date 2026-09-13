import { describe, it, expect } from "vitest";
import { analyzePrivacy, type PrivacyAnalysisInput } from "@/privacy/privacy-analyzer";
import type { DomPrivacyScan } from "@/privacy/dom-scanner";
import type { OcrProvider } from "@/privacy/ocr";
import type { VisionDetection, VisionRaster } from "@/vision/types";

/* ------------------------------------------------------------------ *
 * privacy-analyzer.test.ts — end-to-end orchestration: DOM (viewport),
 * vision (image), OCR (provider raster) all reduced to canonical image
 * coords, fused, and meta-metrics reported.
 * ------------------------------------------------------------------ */

function makeDomScan(signals: DomPrivacyScan["signals"]): DomPrivacyScan {
  return {
    viewport: { width: 320, height: 200 },
    signals,
    scanned: 3,
    domScanMs: 1.25,
  };
}

const IMAGE = { width: 640, height: 400 };

describe("privacy-analyzer.ts", () => {
  it("maps DOM viewport signals into image coordinates (scale 2x)", async () => {
    const input: PrivacyAnalysisInput = {
      image: IMAGE,
      viewport: { width: 320, height: 200 },
      dom: makeDomScan([
        {
          type: "PASSWORD",
          bbox: { x: 48, y: 156, width: 360, height: 44 },
          confidence: 0.96,
          source: "dom",
          detector: "dom:input-password",
          coordinateSystem: "viewport",
        },
      ]),
    };
    const analysis = await analyzePrivacy(input);
    expect(analysis.regions).toHaveLength(1);
    expect(analysis.regions[0].type).toBe("PASSWORD");
    expect(analysis.regions[0].bbox.x).toBe(96); // 48 * 2
    expect(analysis.regions[0].bbox.y).toBe(312); // 156 * 2
    expect(analysis.regions[0].bbox.width).toBe(720); // 360 * 2
    expect(analysis.regions[0].bbox.height).toBe(88);
    // image fix bound stays consistent
    expect(analysis.regions[0].image).toEqual(IMAGE);
    // report per-source counts
    expect(analysis.sourceCounts.dom).toBe(1);
    expect(analysis.typeCounts.PASSWORD).toBe(1);
  });

  it("combines vision face detections with DOM text regions", async () => {
    const visionDets: VisionDetection[] = [
      { type: "face", label: "person", confidence: 0.85, bbox: { x: 100, y: 50, width: 120, height: 140 } },
    ];
    const input: PrivacyAnalysisInput = {
      image: IMAGE,
      viewport: IMAGE,
      visionDetections: visionDets,
      dom: makeDomScan([
        {
          type: "AADHAAR",
          bbox: { x: 10, y: 10, width: 240, height: 40 },
          confidence: 0.95,
          source: "text",
          detector: "dom:text-field-value:aadhaar",
          coordinateSystem: "viewport",
        },
      ]),
    };
    const analysis = await analyzePrivacy(input);
    const types = analysis.regions.map((r) => r.type).sort();
    expect(types).toEqual(["AADHAAR", "FACE"]);
    expect(analysis.sourceCounts.vision).toBe(1);
    expect(analysis.sourceCounts.text).toBe(1);
  });

  it("runs OCR through the provided provider (if given) and scales into image space", async () => {
    const ocrProvider: OcrProvider = {
      name: "scripted",
      async extract() {
        return {
          words: [{ text: "234567890124", confidence: 0.9, bbox: { x: 10, y: 20, width: 100, height: 20 } }],
        };
      },
    };
    const raster: VisionRaster = { width: 160, height: 100, data: new Uint8ClampedArray(160 * 100 * 4) };
    const input: PrivacyAnalysisInput = {
      image: IMAGE,
      viewport: IMAGE,
      ocrProvider,
      ocrRaster: raster,
    };
    const analysis = await analyzePrivacy(input);
    const aadhaars = analysis.regions.filter((r) => r.type === "AADHAAR");
    expect(aadhaars).toHaveLength(1);
    // scale 4x: (10,20,100,20) → (40,80,400,80)
    expect(aadhaars[0].bbox).toEqual({ x: 40, y: 80, width: 400, height: 80 });
    expect(analysis.sourceCounts.ocr).toBe(1);
    expect(analysis.metrics.ocrMs).toBeGreaterThanOrEqual(0);
  });

  it("skips OCR when no provider is supplied", async () => {
    const input: PrivacyAnalysisInput = { image: IMAGE, viewport: IMAGE };
    const analysis = await analyzePrivacy(input);
    expect(analysis.metrics.ocrMs).toBe(0);
    expect(analysis.regions).toEqual([]);
  });

  it("reports stage metrics (capture/vision/dom/fusion/total) and counts", async () => {
    const input: PrivacyAnalysisInput = {
      image: IMAGE,
      viewport: IMAGE,
      captureMs: 40.5,
      visionMs: 610.25,
      dom: makeDomScan([
        {
          type: "PASSWORD",
          bbox: { x: 0, y: 0, width: 100, height: 40 },
          confidence: 0.96,
          source: "dom",
          detector: "dom:input-password",
          coordinateSystem: "viewport",
        },
      ]),
      visionDetections: [
        { type: "face", label: "person", confidence: 0.8, bbox: { x: 400, y: 200, width: 50, height: 50 } },
      ],
    };
    const analysis = await analyzePrivacy(input);
    expect(analysis.metrics.captureMs).toBe(40.5);
    expect(analysis.metrics.domScanMs).toBe(1.25);
    expect(analysis.metrics.visionMs).toBe(610.25);
    expect(analysis.metrics.fusionMs).toBeGreaterThanOrEqual(0);
    expect(analysis.metrics.totalMs).toBeGreaterThanOrEqual(
      analysis.metrics.captureMs + analysis.metrics.domScanMs + analysis.metrics.visionMs,
    );
    expect(analysis.metrics.candidateCount).toBe(2);
    expect(analysis.metrics.regionCount).toBe(2);
    expect(analysis.sourceCounts.dom).toBe(1);
    expect(analysis.sourceCounts.vision).toBe(1);
  });

  it("never leaks raw PII values into region evidence", async () => {
    const input: PrivacyAnalysisInput = {
      image: IMAGE,
      viewport: IMAGE,
      dom: makeDomScan([
        {
          type: "AADHAAR",
          bbox: { x: 0, y: 0, width: 100, height: 40 },
          confidence: 0.95,
          source: "text",
          detector: "dom:text-field-value:aadhaar",
          coordinateSystem: "viewport",
        },
      ]),
    };
    const analysis = await analyzePrivacy(input);
    const evidenceJson = JSON.stringify(analysis.regions[0].evidence);
    expect(evidenceJson).not.toMatch(/\d{10,12}/);
    expect(evidenceJson).not.toMatch(/\d{4}\s?\d{4}\s?\d{4}/);
  });
});