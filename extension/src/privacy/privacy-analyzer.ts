/* ------------------------------------------------------------------ *
 * Privacy analyzer — the top-level orchestration point.
 *
 *   screenshot / capture
 *        ↓
 *   vision regions (Phase 1 detector)
 *        ↓
 *   DOM regions   ─── existing PII engine
 *   text regions  ─── existing PII engine
 *   OCR regions   ─── pluggable provider + existing PII engine
 *        ↓
 *   fusion engine  (region-fusion.ts)
 *        ↓
 *   SensitiveRegion[] + measured stage timings
 *
 * Every source is reduced to canonical image-relative coordinates
 * before fusion. No two coordinate systems are ever compared raw.
 * ------------------------------------------------------------------ */

import { visionDetectionsToRegions } from "./vision-regions";
import { ocrToCandidateRegions, type OcrProvider } from "./ocr";
import { fuseRegionList, type CandidateRegion } from "./region-fusion";
import { viewportToImage, type ViewportScale } from "./coords";
import { MIN_REGION_CONFIDENCE, type RegionSize, type SensitiveType, type SensitiveRegion, type RegionSource } from "./regions";
import type { DomPrivacyScan, DomSignal } from "./dom-scanner";
import type { VisionDetection, VisionRaster } from "@/vision/types";

export interface PrivacyAnalysisStages {
  captureMs: number;
  visionMs: number;
  domScanMs: number;
  ocrMs: number;
  fusionMs: number;
  totalMs: number;
}

export interface PrivacyAnalysisMetrics {
  captureMs: number;
  domScanMs: number;
  visionMs: number;
  ocrMs: number;
  fusionMs: number;
  totalMs: number;
  /** Number of candidates entering fusion (before merge). */
  candidateCount: number;
  /** Number of final SensitiveRegion(s) leaving fusion. */
  regionCount: number;
}

export interface PrivacyAnalysisInput {
  /** Full capture raster dimensions (canonical image-relative). */
  image: RegionSize;
  /** Viewport dimensions at capture time (viewport → image conversion). */
  viewport: RegionSize;
  /** DOM privacy scan output from the content script (optional). */
  dom?: DomPrivacyScan | null;
  /** Real detections from the vision worker (optional). */
  visionDetections?: readonly VisionDetection[] | null;
  /** Total inference time in ms (including preprocess + postprocess). */
  visionMs?: number;
  /** Capture time in ms (measure externally and pass in). */
  captureMs?: number;
  /** Optional OCR provider (not bundled in Phase 2). */
  ocrProvider?: OcrProvider | null;
  /** Raster for OCR (same or full-resolution). */
  ocrRaster?: VisionRaster | null;
  /** Minimum confidence threshold (default from regions.ts constant). */
  minConfidence?: number;
}

export interface PrivacyAnalysis {
  regions: SensitiveRegion[];
  metrics: PrivacyAnalysisMetrics;
  /** Final set of sources represented across all fused regions. */
  sourceCounts: Record<RegionSource, number>;
  /** Final set of types found across all fused regions. */
  typeCounts: Record<SensitiveType, number>;
}

/**
 * Full privacy analysis: converts every source to image-relative
 * coordinates, runs OCR if a provider is supplied, then fuses all
 * candidate regions into the canonical SensitiveRegion list.
 */
export async function analyzePrivacy(input: PrivacyAnalysisInput): Promise<PrivacyAnalysis> {
  const t0 = performance.now();
  const minConfidence = input.minConfidence ?? MIN_REGION_CONFIDENCE;
  const scale: ViewportScale = { viewport: input.viewport, image: input.image };
  const allCandidates: CandidateRegion[] = [];

  /* ---- DOM (viewport → image) ---- */
  const domSignals = input.dom?.signals ?? [];
  const domScanMs = input.dom?.domScanMs ?? 0;
  for (const sig of domSignals) {
    allCandidates.push(domCandidateFromSignal(sig, scale));
  }

  /* ---- Vision (already image-relative) ---- */
  const visionRegs = visionDetectionsToRegions(input.visionDetections ?? [], input.image, minConfidence);
  allCandidates.push(...visionRegs);

  /* ---- OCR (provider raster → image) ---- */
  let ocrMs = 0;
  if (input.ocrProvider && input.ocrRaster) {
    const ocrStart = performance.now();
    const regs = await ocrToCandidateRegions(input.ocrProvider, input.ocrRaster, input.image, minConfidence);
    allCandidates.push(...regs);
    ocrMs = performance.now() - ocrStart;
  }

  /* ---- Fusion ---- */
  const fusionStart = performance.now();
  const regions = fuseRegionList(allCandidates, input.image, minConfidence);
  const fusionMs = performance.now() - fusionStart;

  const internalMs = performance.now() - t0;
  const totalMs =
    internalMs +
    (input.captureMs ?? 0) +
    (input.visionMs ?? 0) +
    domScanMs;

  /* ---- Metrics ---- */
  const sourceCounts: Record<RegionSource, number> = { vision: 0, dom: 0, ocr: 0, text: 0 };
  const typeCounts: Record<SensitiveType, number> = {
    FACE: 0, PASSWORD: 0, CARD_NUMBER: 0, AADHAAR: 0, PAN: 0, UPI: 0,
    PHONE: 0, EMAIL: 0, IFSC: 0, PASSPORT: 0, VOTER_ID: 0, DRIVING_LICENSE: 0, SSN: 0,
  };
  for (const r of regions) {
    sourceCounts[r.source]++;
    typeCounts[r.type]++;
  }

  return {
    regions,
    metrics: {
      captureMs: input.captureMs ?? 0,
      domScanMs,
      visionMs: input.visionMs ?? 0,
      ocrMs,
      fusionMs,
      totalMs,
      candidateCount: allCandidates.length,
      regionCount: regions.length,
    },
    sourceCounts,
    typeCounts,
  };
}

/* ------------------------------------------------------------------ *
 * Internal mapping
 * ------------------------------------------------------------------ */

function domCandidateFromSignal(
  sig: DomSignal,
  scale: ViewportScale,
): CandidateRegion {
  return {
    type: sig.type,
    bbox: viewportToImage(sig.bbox, scale),
    confidence: sig.confidence,
    source: sig.source,
    detector: sig.detector,
    pattern: sig.pattern,
    contextLabel: sig.contextLabel,
    coordinateSystem: "image",
  };
}