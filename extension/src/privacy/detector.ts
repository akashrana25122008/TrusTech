/* ------------------------------------------------------------------ *
 * PII detector — multilingual detection engine entry point.
 *
 * The engine pipeline (scripts → detectors → fusion) runs every scan:
 * Indic-script normalization, checksum/context-validated Indian
 * identifiers (Aadhaar/PAN/UPI/IFSC/…), Hinglish-aware context cues,
 * overlap dedup and confidence scoring. See fusion.ts for the full
 * pipeline; this module keeps the stable detect/redact API the
 * firewall and UI consume.
 * ------------------------------------------------------------------ */

import { scanText, type FindingType } from "./fusion";

export type PiiType =
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

export interface PiiMatch {
  type: PiiType;
  start: number;
  end: number;
  /** The raw matched segment. */
  segment: string;
}

export interface PiiRule {
  type: PiiType;
  /** Unicode-aware detector — returns the first match at each scan position. */
  test: (text: string, index: number) => Omit<PiiMatch, "type"> | null;
}

/** Runs every rule against the supplied rule set (helpers below). */

export function matchSubstring(re: RegExp): PiiRule["test"] {
  return (text, index) => {
    re.lastIndex = 0;
    const m = re.exec(text.slice(index));
    if (!m || m.index < 0) return null;
    return { start: index + m.index, end: index + m.index + m[0].length, segment: m[0] };
  };
}

/** Legacy scan path for explicit rule sets (kept for compatibility). */
function scanWithRules(text: string, rules: readonly PiiRule[]): PiiMatch[] {
  const found: PiiMatch[] = [];
  for (const rule of rules) {
    let cursor = 0;
    while (cursor < text.length) {
      const match = rule.test(text, cursor);
      if (!match) break;
      found.push({ type: rule.type, ...match });
      cursor = match.end > cursor ? match.end : cursor + 1;
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Scan a document text and return all PII matches, non-overlapping,
 * sorted. Without explicit rules this runs the full multilingual engine
 * (normalization → detectors → fusion); findings map back onto the
 * original string, so spans are redaction-safe across scripts.
 */
export function detectPii(text: string, rules?: readonly PiiRule[]): PiiMatch[] {
  if (rules) return scanWithRules(text, rules);
  return scanText(text, "dom-text").map((f) => ({
    type: f.type as PiiType satisfies FindingType,
    start: f.start,
    end: f.end,
    segment: f.segment,
  }));
}

/** Mask a single match using its PII type. */
export function maskFor(type: PiiType): string {
  switch (type) {
    case "email":
      return "[email]";
    case "phone":
      return "[phone]";
    case "credit_card":
      return "[card]";
    case "ssn":
      return "[ssn]";
    case "aadhaar":
      return "[aadhaar]";
    case "pan":
      return "[pan]";
    case "upi":
      return "[upi]";
    case "ifsc":
      return "[ifsc]";
    case "passport":
      return "[passport]";
    case "voter_id":
      return "[voter]";
    case "driving_licence":
      return "[licence]";
    case "ipv4":
      return "[ip]";
    case "postal":
      return "[postal]";
  }
}

/**
 * Redact every PII occurrence. When `keepLength` is set the original
 * length is preserved (debugging friendly); otherwise a fixed mask is
 * used so lengths never leak secrets.
 */
export function redactPii(text: string, matches: PiiMatch[], keepLength = false): string {
  if (matches.length === 0) return text;
  const mask = (type: PiiType, raw: string) => {
    const m = maskFor(type);
    if (!keepLength) return m;
    // head + padding + tail must equal the raw length (no length leak).
    const head = m.slice(0, m.length - 1);
    const tail = m[m.length - 1];
    const padding = "•".repeat(Math.max(0, raw.length - m.length));
    return `${head}${padding}${tail}`;
  };

  let out = "";
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    out += text.slice(cursor, m.start) + mask(m.type, m.segment);
    cursor = m.end;
  }
  out += text.slice(cursor);
  return out;
}
