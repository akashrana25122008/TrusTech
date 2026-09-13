/* ------------------------------------------------------------------ *
 * Vision → SensitiveRegion candidates.
 *
 * The Phase 1 detector runs YOLOS-tiny over the captured raster. Only a
 * subset of its 91 COCO labels maps onto the canonical privacy
 * vocabulary — seeing the code and message here keeps that mapping
 * explicit and auditable:
 *
 *   person → FACE            (biometric presence, no identity claims)
 *
 * Every other COCO class (tv, cell phone, laptop, …) is treated as
 * layout/context evidence and is NEVER promoted to a canonical
 * SensitiveRegion on its own — visual-only claims require object-level
 * class evidence, and those classes are not in the privacy vocabulary.
 * ------------------------------------------------------------------ */

import { MIN_REGION_CONFIDENCE, patternNameFor, type RegionSize, type SensitiveType } from "./regions";
import type { CandidateRegion } from "./region-fusion";
import type { VisionDetection } from "@/vision/types";

/** Canonical type emitted for a Phase 1 vision detection. */
export function visionDetectionType(detection: VisionDetection): SensitiveType | null {
  switch (detection.type) {
    case "face":
      return "FACE";
    default:
      return null;
  }
}

/** Map real vision detections onto canonical candidate regions. */
export function visionDetectionsToRegions(
  detections: readonly VisionDetection[] | null | undefined,
  image: RegionSize,
  minConfidence = MIN_REGION_CONFIDENCE,
): CandidateRegion[] {
  if (!detections) return [];
  const out: CandidateRegion[] = [];
  for (const d of detections) {
    const type = visionDetectionType(d);
    if (!type) continue;
    if (d.confidence < minConfidence) continue;
    // A face box is a single-plane box; trust the model's number verbatim
    // and clamp it into the canonical image so it stays comparable to the
    // other coordinate systems.
    const bbox = {
      x: Math.min(Math.max(0, d.bbox.x), image.width),
      y: Math.min(Math.max(0, d.bbox.y), image.height),
      width: Math.min(Math.max(0, d.bbox.width), Math.max(0, image.width - Math.min(Math.max(0, d.bbox.x), image.width))),
      height: Math.min(Math.max(0, d.bbox.height), Math.max(0, image.height - Math.min(Math.max(0, d.bbox.y), image.height))),
    };
    out.push({
      type,
      bbox,
      confidence: d.confidence,
      source: "vision",
      detector: "yolos-tiny",
      pattern: patternNameFor(type),
      coordinateSystem: "image",
    });
  }
  return out;
}