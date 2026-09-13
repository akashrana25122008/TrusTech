/* ------------------------------------------------------------------ *
 * OCR integration seam.
 *
 * No OCR runtime ships in Phase 2 (PaddleOCR weights are a later phase,
 * matching the Phase 1 plan). This module defines the provider contract
 * and builds canonical candidate regions from OCR output by running each
 * recognized word through the SAME existing Indian/full PII engine that
 * DOM text uses (provenance "ocr") — never a second weaker detector.
 *
 * A provider is injected at the fusion entry point; the seam is wired
 * and unit-tested with a scripted provider. End-to-end OCR latency is
 * therefore reported as NOT TESTED until a real runtime is bundled.
 * ------------------------------------------------------------------ */

import { scanText } from "./fusion";
import { findingToSensitive, MIN_REGION_CONFIDENCE, patternNameFor, type RegionSize } from "./regions";
import { ocrToImage, type OcRasterScale } from "./coords";
import { fuseConfidence, type CandidateRegion } from "./region-fusion";
import type { VisionRaster } from "@/vision/types";

export interface OcrWord {
  text: string;
  confidence: number;
  /** Box in OCR raster coordinates. */
  bbox: { x: number; y: number; width: number; height: number };
}

export interface OcrResult {
  words: OcrWord[];
}

export interface OcrProvider {
  readonly name: string;
  /** Run OCR over a raster; every box is relative to the raster dims. */
  extract(raster: VisionRaster): Promise<OcrResult>;
}

/**
 * Run one OCR word through the existing PII pipeline and emit canonical
 * candidates. The OCR raster may differ from the canonical image — boxes
 * are scaled into image space before fusion.
 */
export async function ocrWordToRegions(
  word: OcrWord,
  scale: OcRasterScale,
  minConfidence = MIN_REGION_CONFIDENCE,
): Promise<CandidateRegion[]> {
  const findings = scanText(word.text, "ocr");
  const bbox = ocrToImage(word.bbox, scale);
  const out: CandidateRegion[] = [];
  for (const f of findings) {
    const type = findingToSensitive(f.type);
    if (!type) continue;
    if (f.confidence < minConfidence) continue;
    out.push({
      type,
      bbox,
      confidence: fuseConfidence([
        { source: "ocr", confidence: word.confidence },
        { source: "text", confidence: f.confidence },
      ]),
      source: "ocr",
      detector: "ocr+" + f.provenance,
      pattern: patternNameFor(type),
      coordinateSystem: "image",
    });
  }
  return out;
}

export async function ocrToCandidateRegions(
  provider: OcrProvider,
  raster: VisionRaster,
  image: RegionSize,
  minConfidence = MIN_REGION_CONFIDENCE,
): Promise<CandidateRegion[]> {
  const result = await provider.extract(raster);
  const scale: OcRasterScale = { ocr: { width: raster.width, height: raster.height }, image };
  const out: CandidateRegion[] = [];
  for (const word of result.words) {
    if (!word.text || word.text.length === 0) continue;
    const regions = await ocrWordToRegions(word, scale, minConfidence);
    out.push(...regions);
  }
  return out;
}