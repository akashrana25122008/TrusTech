/* ------------------------------------------------------------------ *
 * PII fusion — combine regex, checksum, context and visual signals
 * into normalized, deduplicated, confidence-scored findings.
 *
 * Sources (provenance) feed ONE pipeline, so DOM text, form values,
 * ARIA/label strings and OCR text share normalization + detectors:
 *
 *   chunk { text, provenance } ──► normalize ──► detectors ──► fuse
 *                                                              ──► finding
 *
 * Findings are the typed contract Feature #2 (privacy firewall) will
 * consume. Nothing here leaves the device.
 * ------------------------------------------------------------------ */

import {
  normalizeForDetection,
  toOriginalSpan,
  detectLanguage,
  type LanguageHint,
  type NormalizedText,
} from "./scripts";
import {
  detectIndia,
  indiaContextBoost,
  phoneContextBoost,
  INDIA_CONTEXT,
  type IndiaPiiType,
} from "./india";

export type PiiProvenance =
  | "dom-text"
  | "field-value"
  | "field-label"
  | "aria"
  | "ocr";

export type FindingType =
  | "email"
  | "phone"
  | "credit_card"
  | "ssn"
  | "aadhaar"
  | "pan"
  | "upi"
  | "ifsc"
  | "passport"
  | "voter_id"
  | "driving_licence"
  | "ipv4"
  | "postal";

/** Base confidence per finding type (before context boost). */
const BASE_CONFIDENCE: Record<FindingType, number> = {
  email: 0.85,
  phone: 0.85,
  credit_card: 0.9,
  ssn: 0.85,
  aadhaar: 0.95,
  pan: 0.92,
  upi: 0.8,
  ifsc: 0.9,
  passport: 0.75,
  voter_id: 0.75,
  driving_licence: 0.7,
  ipv4: 0.7,
  postal: 0.5,
};

/** Priority for overlap resolution (higher wins ties after confidence). */
const TYPE_PRIORITY: Record<FindingType, number> = {
  aadhaar: 100,
  pan: 95,
  credit_card: 90,
  ssn: 85,
  ifsc: 80,
  passport: 75,
  voter_id: 75,
  driving_licence: 70,
  upi: 65,
  phone: 60,
  email: 55,
  ipv4: 40,
  postal: 30,
};

export interface TextChunk {
  text: string;
  provenance: PiiProvenance;
}

export interface PiiFinding {
  type: FindingType;
  /** Span in the ORIGINAL chunk text (redaction-safe). */
  start: number;
  end: number;
  /** Raw matched segment from the original text. */
  segment: string;
  /** 0..1 confidence after context boost. */
  confidence: number;
  language: LanguageHint;
  provenance: PiiProvenance;
  /** Nearby label cue that supported this finding, if any. */
  contextLabel?: string;
}

interface RawSignal {
  type: FindingType;
  start: number;
  end: number;
  confidence: number;
  /** Nearby label cue supporting this signal, when found. */
  label?: string;
}

/* ---------------- shared (English + global) detectors ---------------- */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CARD_RE =
  /(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?:\s?\d{3,4})?/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const POSTAL_RE = /(?<!\d)(\d{6})(?!\d)/g;

function collectAll(re: RegExp, text: string): Array<{ start: number; end: number }> {
  re.lastIndex = 0;
  const out: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function detectShared(text: string): RawSignal[] {
  const signals: RawSignal[] = [];
  for (const s of collectAll(EMAIL_RE, text)) signals.push({ type: "email", ...s, confidence: BASE_CONFIDENCE.email });
  for (const s of collectAll(CARD_RE, text)) signals.push({ type: "credit_card", ...s, confidence: BASE_CONFIDENCE.credit_card });
  for (const s of collectAll(SSN_RE, text)) signals.push({ type: "ssn", ...s, confidence: BASE_CONFIDENCE.ssn });
  for (const s of collectAll(IPV4_RE, text)) {
    const octets = text.slice(s.start, s.end).split(".").map(Number);
    if (octets.every((o) => o <= 255)) {
      signals.push({ type: "ipv4", ...s, confidence: BASE_CONFIDENCE.ipv4 });
    }
  }
  for (const s of collectAll(POSTAL_RE, text)) signals.push({ type: "postal", ...s, confidence: BASE_CONFIDENCE.postal });
  return signals;
}

/* ---------------- context cues ---------------- */

const EMAIL_CUES = ["email", "ईमेल", "e-mail", "mail id", "मेल"];
const CARD_CUES = ["card", "कार्ड", "credit", "क्रेडिट", "debit", "cvv", "expiry"];
const POSTAL_CUES = ["pin", "postal", "pincode", "zip", "postcode", "पिन", "डाक", "पिन कोड"];
const CONTEXT_BOOST = 0.15;
const CONTEXT_WINDOW = 48;

function contextLabelFor(text: string, start: number, end: number, cues: readonly string[]): string | undefined {
  const lo = Math.max(0, start - CONTEXT_WINDOW);
  const hi = Math.min(text.length, end + CONTEXT_WINDOW);
  const window = text.slice(lo, hi);
  const lower = window.toLowerCase();
  for (const cue of cues) {
    const idx = lower.indexOf(cue.toLowerCase());
    if (idx >= 0) return window.slice(idx, idx + cue.length);
  }
  return undefined;
}

/* ---------------- fusion ---------------- */

export interface FusionOptions {
  /** Minimum confidence to keep a finding (default 0.5). */
  minConfidence?: number;
}

const INDIA_TO_FINDING: Record<IndiaPiiType | "phone_in", FindingType> = {
  aadhaar: "aadhaar",
  pan: "pan",
  phone_in: "phone",
  upi: "upi",
  ifsc: "ifsc",
  passport: "passport",
  voter_id: "voter_id",
  driving_licence: "driving_licence",
};

/** Fuse one normalized chunk's signals into findings (original spans). */
export function fuseChunk(
  rawText: string,
  norm: NormalizedText,
  provenance: PiiProvenance,
  options: FusionOptions = {},
): PiiFinding[] {
  const minConfidence = options.minConfidence ?? 0.5;
  const signals: RawSignal[] = detectShared(norm.text);

  for (const hit of detectIndia(norm)) {
    const type = INDIA_TO_FINDING[hit.kind];
    let confidence = hit.confidence;
    let label: string | undefined;
    if (hit.kind === "phone_in") {
      if (phoneContextBoost(norm.text, hit.start, hit.end) > 0) {
        confidence = Math.min(0.99, confidence + CONTEXT_BOOST);
        label = contextLabelFor(norm.text, hit.start, hit.end, ["mobile", "मोबाइल", "phone", "फोन"]);
      }
    } else {
      const cueType = hit.kind as IndiaPiiType;
      if (indiaContextBoost(norm.text, hit.start, hit.end, cueType) > 0) {
        confidence = Math.min(0.99, confidence + CONTEXT_BOOST);
        label = contextLabelFor(norm.text, hit.start, hit.end, INDIA_CONTEXT[cueType]);
      }
    }
    signals.push({ type, start: hit.start, end: hit.end, confidence, label });
  }

  // Shared detectors get the same context treatment. Postal codes are
  // weak (any 6-digit run) — keep them only beside a postal cue so
  // product IDs, quantities and prices are never eaten.
  const kept: RawSignal[] = [];
  for (const s of signals) {
    if (s.type === "postal") {
      s.label = contextLabelFor(norm.text, s.start, s.end, POSTAL_CUES);
      if (!s.label) continue;
    } else if (s.type === "email" && !s.label) {
      s.label = contextLabelFor(norm.text, s.start, s.end, EMAIL_CUES);
    } else if (s.type === "credit_card" && !s.label) {
      s.label = contextLabelFor(norm.text, s.start, s.end, CARD_CUES);
    }
    if (s.label) s.confidence = Math.min(0.99, s.confidence + CONTEXT_BOOST);
    kept.push(s);
  }
  signals.length = 0;
  signals.push(...kept);

  // Rank: confidence desc, then length desc, then type priority.
  signals.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) return lenB - lenA;
    return (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0);
  });

  // Greedy non-overlapping acceptance.
  const accepted: RawSignal[] = [];
  for (const s of signals) {
    if (s.confidence < minConfidence) continue;
    const overlaps = accepted.some((a) => s.start < a.end && a.start < s.end);
    if (!overlaps) accepted.push(s);
  }
  accepted.sort((a, b) => a.start - b.start);

  return accepted.map((s) => {
    const span = toOriginalSpan(norm, s.start, s.end);
    const segment = rawText.slice(span.start, span.end);
    const finding: PiiFinding = {
      type: s.type,
      start: span.start,
      end: span.end,
      segment,
      confidence: Math.round(s.confidence * 100) / 100,
      language: detectLanguage(segment, rawText.slice(Math.max(0, span.start - 48), span.end + 48)),
      provenance,
    };
    if (s.label) finding.contextLabel = s.label;
    return finding;
  });
}

/**
 * Scan one or more text chunks (DOM text, field values, ARIA strings,
 * OCR output) through the shared pipeline. Returns findings sorted by
 * position within each chunk, chunk order preserved.
 */
export function scanSources(chunks: TextChunk[], options: FusionOptions = {}): PiiFinding[] {
  const out: PiiFinding[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk.text) continue;
    const norm = normalizeForDetection(chunk.text);
    for (const f of fuseChunk(chunk.text, norm, chunk.provenance, options)) {
      // Cross-chunk dedup: same type + same normalized segment once.
      const key = `${f.type}|${f.segment.replace(/\s+/g, " ").trim().toLowerCase()}|${f.provenance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** Convenience scan for a single raw string (defaults to dom-text). */
export function scanText(text: string, provenance: PiiProvenance = "dom-text", options: FusionOptions = {}): PiiFinding[] {
  return scanSources([{ text, provenance }], options);
}

/* ---------------- visual / OCR seam ---------------- */

export interface VisualTextSource {
  /** Text produced by OCR (PaddleOCR-compatible output) over a viewport, frame or image region. */
  text: string;
  /** Optional source dimensions (for future region-level findings). */
  width?: number;
  height?: number;
  languageHint?: LanguageHint;
}

/**
 * Run OCR-produced text through the SAME detection pipeline with
 * provenance "ocr". The OCR runtime itself (PaddleOCR weights) ships in
 * a later phase; this seam guarantees visual text is never handled by a
 * second, weaker detector when it arrives.
 */
export function scanVisualText(source: VisualTextSource, options: FusionOptions = {}): PiiFinding[] {
  if (!source.text) return [];
  return scanSources([{ text: source.text, provenance: "ocr" }], options);
}
