/* ------------------------------------------------------------------ *
 * Visual + DOM privacy intelligence — canonical contracts.
 *
 * This module defines the ONE stable vocabulary the whole privacy
 * pipeline shares:
 *   • SensitiveType — canonical types (FACE/PASSWORD/AADHAAR/…)
 *   • SensitiveRegion — the final fused, decision-ready unit
 *   • Severity + confidence rules (deterministic and testable)
 *
 * Coordinates are ALWAYS "captured-image-relative" (see coords.ts).
 * Every rule below is a pure function of its inputs so the fusion and
 * decision layers stay auditable.
 * ------------------------------------------------------------------ */

import type { FindingType } from "./fusion";

export type SensitiveType =
  | "FACE"
  | "PASSWORD"
  | "CARD_NUMBER"
  | "AADHAAR"
  | "PAN"
  | "UPI"
  | "PHONE"
  | "EMAIL"
  | "IFSC"
  | "PASSPORT"
  | "VOTER_ID"
  | "DRIVING_LICENSE"
  | "SSN";

export type RegionSource = "vision" | "dom" | "ocr" | "text";

export type RegionSeverity = "high" | "medium" | "low";

export type RegionCoordinateSystem = "image" | "viewport" | "ocr";

export interface RegionBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionSize {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Confidence rules
 * ------------------------------------------------------------------ */

/** Below this threshold a candidate is not even kept for fusion. */
export const MIN_REGION_CONFIDENCE = 0.5;
/** At/above this, an evidence source counts as "strong" for conflicts. */
export const STRONG_CONFIDENCE = 0.65;
/** Below this, an evidence source counts as "weak" for conflicts. */
export const WEAK_CONFIDENCE = 0.55;
/** Soft ceiling for combined confidence (agreement should not reach 1.0). */
export const MAX_FUSED_CONFIDENCE = 0.99;

/**
 * Source reliability — how much a single evidence source is trusted when
 * multiple sources corroborate the same region. Deterministic weights:
 *   dom   → 1.0  structural, hard to fool
 *   text  → 1.0  pattern + checksum validated by the existing PII engine
 *   vision → 0.9  model confidence on an open object set
 *   ocr   → 0.85  reading errors on pixels
 * These weights participate in the noisy-OR combination in region-fusion.
 */
export const SOURCE_RELIABILITY: Record<RegionSource, number> = {
  dom: 1.0,
  text: 1.0,
  vision: 0.9,
  ocr: 0.85,
};

/* ------------------------------------------------------------------ *
 * Severity model
 *
 * Nominal severity by type, then adjusted deterministically by the
 * combined confidence of the region:
 *   confidence >= STRONG_CONFIDENCE → nominal severity
 *   STRONG > confidence > MIN       → one level softer
 *   confidence == MIN               → low
 *
 * HIGH  = credentials / payment / government identity / biometrics
 * MEDIUM= personal contact identifiers (still sensitive by context)
 * LOW   = weak or low-confidence evidence kept for transparency
 * ------------------------------------------------------------------ */

const HIGH_TYPES: ReadonlySet<SensitiveType> = new Set([
  "FACE",
  "PASSWORD",
  "CARD_NUMBER",
  "AADHAAR",
  "PAN",
  "SSN",
  "PASSPORT",
  "VOTER_ID",
  "DRIVING_LICENSE",
]);

const MEDIUM_TYPES: ReadonlySet<SensitiveType> = new Set(["UPI", "IFSC", "PHONE", "EMAIL"]);

export function baseSeverityFor(type: SensitiveType): RegionSeverity {
  if (HIGH_TYPES.has(type)) return "high";
  if (MEDIUM_TYPES.has(type)) return "medium";
  return "low";
}

export function severityFor(type: SensitiveType, confidence: number): RegionSeverity {
  const base = baseSeverityFor(type);
  if (confidence >= STRONG_CONFIDENCE) return base;
  if (confidence > MIN_REGION_CONFIDENCE) return base === "high" ? "medium" : "low";
  return "low";
}

/** Tie-break and conflict priority (higher wins all else equal). */
export const TYPE_PRIORITY: Record<SensitiveType, number> = {
  AADHAAR: 100,
  PAN: 95,
  SSN: 90,
  CARD_NUMBER: 90,
  PASSPORT: 85,
  DRIVING_LICENSE: 82,
  VOTER_ID: 80,
  PASSWORD: 78,
  FACE: 75,
  UPI: 65,
  IFSC: 62,
  PHONE: 60,
  EMAIL: 55,
};

export function typePriority(type: SensitiveType): number {
  return TYPE_PRIORITY[type] ?? 0;
}

/* ------------------------------------------------------------------ *
 * Evidence provenance (kept per region, never the raw matched value)
 * ------------------------------------------------------------------ */

export interface RegionEvidence {
  source: RegionSource;
  confidence: number;
  /** Detector name, e.g. "yolos-tiny", "dom:password", "india:aadhaar". */
  detector: string;
  /** Pattern kind (e.g. "verhoeff:aadhaar"), NOT the matched value. */
  pattern?: string;
  /** Nearby UI/label cue that supported the evidence, when known. */
  contextLabel?: string;
}

export interface SensitiveRegion {
  type: SensitiveType;
  /** Canonical captured-image-relative box. */
  bbox: RegionBBox;
  /** Combined 0..1 confidence from all evidence (never fabricated). */
  confidence: number;
  severity: RegionSeverity;
  /** Dominant evidence source (see sources for the full set). */
  source: RegionSource;
  /** Every source that contributed evidence to this region. */
  sources: RegionSource[];
  evidence: RegionEvidence[];
  /** Canonical image dimensions this box is relative to. */
  image: RegionSize;
  /** 0..1 normalized box (handy for overlays rendered against any size). */
  normalized: RegionBBox;
}

/* ------------------------------------------------------------------ *
 * Canonical type mapping (text findings → SensitiveType)
 * ------------------------------------------------------------------ */

/** Map existing PII finding types onto the canonical vocabulary. */
export const FINDING_TO_SENSITIVE: Record<FindingType, SensitiveType | null> = {
  email: "EMAIL",
  phone: "PHONE",
  credit_card: "CARD_NUMBER",
  ssn: "SSN",
  aadhaar: "AADHAAR",
  pan: "PAN",
  upi: "UPI",
  ifsc: "IFSC",
  passport: "PASSPORT",
  voter_id: "VOTER_ID",
  driving_licence: "DRIVING_LICENSE",
  // IPv4 and postal codes are not personal sensitive identifiers in the
  // product's model — they stay queryable in text but never become a
  // canonical SensitiveRegion.
  ipv4: null,
  postal: null,
};

export function findingToSensitive(type: FindingType): SensitiveType | null {
  return FINDING_TO_SENSITIVE[type];
}

/** Detector label used in evidence for a canonical type source. */
export function patternNameFor(type: SensitiveType): string {
  switch (type) {
    case "FACE":
      return "vision:coco-person";
    case "PASSWORD":
      return "dom:input-password";
    case "CARD_NUMBER":
      return "text:credit-card";
    case "AADHAAR":
      return "text:aadhaar-verhoeff";
    case "PAN":
      return "text:pan";
    case "UPI":
      return "text:upi";
    case "PHONE":
      return "text:phone";
    case "EMAIL":
      return "text:email";
    case "IFSC":
      return "text:ifsc";
    case "PASSPORT":
      return "text:passport";
    case "VOTER_ID":
      return "text:voter-id";
    case "DRIVING_LICENSE":
      return "text:driving-licence";
    case "SSN":
      return "text:ssn";
  }
}