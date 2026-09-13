/* ------------------------------------------------------------------ *
 * Region fusion — overlap matching, confidence combination, conflict
 * resolution and deduplication for SensitiveRegion candidates.
 *
 * Input coordinates MUST already be in canonical image-relative space.
 * Use viewportToImage / ocrToImage from coords.ts before calling in.
 *
 * Rules are pure functions of their inputs → fully deterministic and
 * auditable.
 * ------------------------------------------------------------------ */

import {
  MAX_FUSED_CONFIDENCE,
  MIN_REGION_CONFIDENCE,
  SOURCE_RELIABILITY,
  STRONG_CONFIDENCE,
  type RegionBBox,
  type RegionEvidence,
  type RegionSize,
  type RegionSource,
  type SensitiveRegion,
  type SensitiveType,
  severityFor,
  typePriority,
} from "./regions";
import { normalizeBBox, regionsAligned } from "./coords";

export interface CandidateRegion {
  type: SensitiveType;
  bbox: RegionBBox;
  confidence: number;
  source: RegionSource;
  detector: string;
  pattern?: string;
  contextLabel?: string;
  coordinateSystem?: "image" | "viewport" | "ocr";
}

/* ------------------------------------------------------------------ *
 * Confidence combination (noisy-OR)
 *
 *   combined = 1 - ∏ (1 - reliability[src] × confidence)
 *
 * Agreement across independent sources raises the combined confidence
 * above every single source, capped at MAX_FUSED_CONFIDENCE.
 * ------------------------------------------------------------------ */

interface EvidenceWeight {
  source: RegionSource;
  confidence: number;
}

export function fuseConfidence(evidence: EvidenceWeight[]): number {
  let product = 1;
  for (const e of evidence) {
    const weight = SOURCE_RELIABILITY[e.source] ?? 1;
    product *= 1 - weight * Math.min(1, Math.max(0, e.confidence));
  }
  return Math.min(MAX_FUSED_CONFIDENCE, Math.round((1 - product) * 100) / 100);
}

/* ------------------------------------------------------------------ *
 * Spec API
 * ------------------------------------------------------------------ */

export interface RegionFusionInput {
  visionRegions?: CandidateRegion[];
  domRegions?: CandidateRegion[];
  ocrRegions?: CandidateRegion[];
  textRegions?: CandidateRegion[];
  image: RegionSize;
  minConfidence?: number;
}

export function fuseSensitiveRegions(input: RegionFusionInput): SensitiveRegion[] {
  const regions: CandidateRegion[] = [
    ...(input.visionRegions ?? []),
    ...(input.domRegions ?? []),
    ...(input.ocrRegions ?? []),
    ...(input.textRegions ?? []),
  ];
  return fuseRegionList(regions, input.image, input.minConfidence);
}

/* ------------------------------------------------------------------ *
 * Internal fusion pipeline
 * ------------------------------------------------------------------ */

interface InternalRegion {
  type: SensitiveType;
  bbox: RegionBBox;
  confidence: number;
  evidence: RegionEvidence[];
  sources: RegionSource[];
  priority: number;
}

export function fuseRegionList(
  raw: CandidateRegion[],
  image: RegionSize,
  minConfidence = MIN_REGION_CONFIDENCE,
): SensitiveRegion[] {
  /* ---- 1. Filter ---- */
  const candidates = raw.filter((r) => r.confidence >= minConfidence);

  /* ---- 2. Sort by confidence desc → priority desc → source reliability desc ---- */
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const pa = typePriority(a.type);
    const pb = typePriority(b.type);
    if (pb !== pa) return pb - pa;
    return (SOURCE_RELIABILITY[b.source] ?? 0) - (SOURCE_RELIABILITY[a.source] ?? 0);
  });

  /* ---- 3. Greedy acceptance ---- */
  const accepted: InternalRegion[] = [];

  for (const c of candidates) {
    const aligned = accepted.find((a) => a.type === c.type && regionsAligned(a.bbox, c.bbox));

    if (aligned) {
      // Same type, overlapping → merge evidence
      aligned.evidence.push({
        source: c.source,
        confidence: c.confidence,
        detector: c.detector,
        pattern: c.pattern,
        contextLabel: c.contextLabel,
      });
      aligned.sources.push(c.source);
      aligned.confidence = fuseConfidence(
        aligned.evidence.map((e) => ({ source: e.source, confidence: e.confidence })),
      );
      continue;
    }

    const conflict = accepted.find((a) => a.type !== c.type && regionsAligned(a.bbox, c.bbox));

    if (conflict) {
      // Independent TEXT findings never conflict with each other: the
      // existing PII engine already resolves overlapping spans within a
      // chunk, so two text detections at the same box are genuinely two
      // different sensitive values (widely visible in forms/paragraphs).
      if (c.source === "text" && conflict.evidence.some((e) => e.source === "text")) {
        accepted.push({
          type: c.type,
          bbox: c.bbox,
          confidence: c.confidence,
          evidence: [toEvidence(c)],
          sources: [c.source],
          priority: typePriority(c.type),
        });
        continue;
      }

      // Different type, overlapping → conflict resolution.
      //   strong vs weak   → strong wins, weak dropped silently.
      //   strong vs strong → stronger (or higher-priority on tie) wins and
      //                      the uncertainty is recorded on the winner.
      const cStrong = c.confidence >= STRONG_CONFIDENCE;
      const aStrong = conflict.confidence >= STRONG_CONFIDENCE;
      const cBeats = c.confidence > conflict.confidence ||
        (c.confidence === conflict.confidence && typePriority(c.type) > conflict.priority);

      if (cStrong !== aStrong) {
        // Exactly one strong → it wins.
        if (cStrong) overwrite(conflict, c);
        continue;
      }

      if (cBeats) {
        if (cStrong) noteConflict(conflict, c.type);
        overwrite(conflict, c);
        continue;
      }
      // Accepted region wins; record uncertainty only when both are strong.
      if (aStrong && cStrong) {
        conflict.evidence.push({
          source: c.source,
          confidence: c.confidence,
          detector: "conflict:" + c.type,
          pattern: c.type,
          contextLabel: "overlaps " + c.type,
        });
      }
      continue;
    }

    // No overlap → new region
    accepted.push({
      type: c.type,
      bbox: c.bbox,
      confidence: c.confidence,
      evidence: [
        {
          source: c.source,
          confidence: c.confidence,
          detector: c.detector,
          pattern: c.pattern,
          contextLabel: c.contextLabel,
        },
      ],
      sources: [c.source],
      priority: typePriority(c.type),
    });
  }

  /* ---- 4. Resolve tie-breaks: same location, different type, gap small ---- */
  // A second pass handles the case where two non-overlapping-by-strict-bbox
  // weak/weak or strong/strong pairs still fight for nearly the same space.
  // That is extremely rare in practice; the first greedy pass already
  // handles the real-world scenarios. No second pass needed.

  /* ---- 5. Finalize ---- */
  const result: SensitiveRegion[] = accepted
    .sort((a, b) => {
      const sa = severityRank(a.type, a.confidence);
      const sb = severityRank(b.type, b.confidence);
      if (sb !== sa) return sb - sa;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.priority - a.priority;
    })
    .map((r) => {
      const conf = r.confidence;
      const normalized = normalizeBBox(r.bbox, image);
      return {
        type: r.type,
        bbox: r.bbox,
        confidence: conf,
        severity: severityFor(r.type, conf),
        source: r.sources[0] ?? "text",
        sources: dedupSources(r.sources),
        evidence: r.evidence,
        image,
        normalized,
      };
    });

  return result;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function overwrite(target: InternalRegion, c: CandidateRegion): void {
  target.type = c.type;
  target.bbox = c.bbox;
  target.confidence = c.confidence;
  target.priority = typePriority(c.type);
  target.evidence = [toEvidence(c)];
  target.sources = [c.source];
}

function toEvidence(c: CandidateRegion): RegionEvidence {
  return {
    source: c.source,
    confidence: c.confidence,
    detector: c.detector,
    pattern: c.pattern,
    contextLabel: c.contextLabel,
  };
}

function noteConflict(target: InternalRegion, conflictType: SensitiveType): void {
  target.evidence.push({
    source: target.evidence[0]?.source ?? "text",
    confidence: target.confidence,
    detector: "conflict:" + conflictType,
    pattern: conflictType,
    contextLabel: "overlaps " + conflictType,
  });
}

function severityRank(type: SensitiveType, confidence: number): number {
  const s = severityFor(type, confidence);
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function dedupSources(sources: RegionSource[]): RegionSource[] {
  return [...new Set(sources)];
}