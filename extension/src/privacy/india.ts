/* ------------------------------------------------------------------ *
 * Indian PII detectors — pattern + checksum + context validation for
 * India-specific identifiers. All detectors run on NORMALIZED text
 * (see scripts.ts: NFKC, Indic digits folded to ASCII), so Devanagari,
 * Bengali, Tamil … digits match the same patterns as Latin digits.
 *
 * Extensible: add a detector entry — no pipeline changes required.
 * ------------------------------------------------------------------ */

import type { NormalizedText } from "./scripts";

export type IndiaPiiType =
  | "aadhaar"
  | "pan"
  | "upi"
  | "ifsc"
  | "passport"
  | "voter_id"
  | "driving_licence";

export interface IndiaHit {
  /** Detector kind; "phone_in" maps onto the shared "phone" PII type. */
  kind: IndiaPiiType | "phone_in";
  /** Span in NORMALIZED coordinates (fusion maps back to original). */
  start: number;
  end: number;
  /** Base confidence 0..1 before context boost. */
  confidence: number;
}

/* ---------------- Verhoeff (Aadhaar checksum) ---------------- */

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 7, 2, 5],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when the 12-digit string passes the Verhoeff checksum. */
export function verhoeffValid(digits12: string): boolean {
  if (!/^\d{12}$/.test(digits12)) return false;
  let c = 0;
  const rev = digits12.split("").reverse().map(Number);
  for (let i = 0; i < rev.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][rev[i]]];
  }
  return c === 0;
}

/** Compute the Verhoeff check digit for an 11-digit prefix (fixtures). */
export function verhoeffCheckDigit(first11: string): string {
  if (!/^\d{11}$/.test(first11)) throw new Error("verhoeffCheckDigit needs 11 digits");
  let c = 0;
  const rev = first11.split("").reverse().map(Number);
  for (let i = 0; i < rev.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][rev[i]]];
  }
  for (let d = 0; d <= 9; d++) {
    if (VERHOEFF_D[c][VERHOEFF_P[0][d]] === 0) return String(d);
  }
  throw new Error("no verhoeff check digit found");
}

/* ---------------- Context lexicon (EN + HI + Hinglish) ---------------- */

export const INDIA_CONTEXT: Record<IndiaPiiType, readonly string[]> = {
  aadhaar: ["aadhaar", "aadhar", "आधार", "uidai", "uid number", "आधार संख्या", "आधार कार्ड"],
  pan: ["pan", "पैन", "permanent account", "आयकर", "income tax", "पैन कार्ड"],
  upi: ["upi", "यूपीआई", "vpa", "bhim", "भीम", "upi id"],
  ifsc: ["ifsc", "आईएफएससी", "ifs code", "bank code", "बैंक कोड"],
  passport: ["passport", "पासपोर्ट"],
  voter_id: ["voter", "epic", "मतदाता", "election", "मतदाता पहचान"],
  driving_licence: ["licence", "license", "लाइसेंस", "driving", "ड्राइविंग", "dl no", "dlno"],
};

/** Generic phone/contact cues (English, Hindi, Hinglish). */
export const PHONE_CONTEXT: readonly string[] = [
  "mobile", "phone", "मोबाइल", "फोन", "फ़ोन", "संपर्क", "contact",
  "telephone", "टेलीफोन", "call", "कॉल", "number", "नंबर", "नम्बर", "फ़ोन नंबर",
];

/** Max confidence lift from a nearby context cue. */
export const CONTEXT_BOOST = 0.15;
/** Characters scanned on each side of a hit for context cues. */
export const CONTEXT_WINDOW = 48;

function hasContextCue(text: string, start: number, end: number, cues: readonly string[]): boolean {
  const lo = Math.max(0, start - CONTEXT_WINDOW);
  const hi = Math.min(text.length, end + CONTEXT_WINDOW);
  const window = text.slice(lo, hi).toLowerCase();
  return cues.some((cue) => window.includes(cue.toLowerCase()));
}

/** Context boost for an Indian-identifier hit (0 or CONTEXT_BOOST). */
export function indiaContextBoost(text: string, start: number, end: number, type: IndiaPiiType): number {
  return hasContextCue(text, start, end, INDIA_CONTEXT[type]) ? CONTEXT_BOOST : 0;
}

/** Context boost for phone hits. */
export function phoneContextBoost(text: string, start: number, end: number): number {
  return hasContextCue(text, start, end, PHONE_CONTEXT) ? CONTEXT_BOOST : 0;
}

/* ---------------- Pattern detectors ---------------- */

const AADHAAR_RE = /(?<!\d)([2-9]\d{3}\s?\d{4}\s?\d{4})(?!\d)/g;
const PAN_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/gi;
// Full span covers an explicit trunk/country prefix, so redaction never
// leaks "+91". The lookbehind (not a consumed boundary char) keeps the
// span exact; inner single separators allow "98765 43210" grouping.
const PHONE_RE = /(?<![\d+])((?:\+?91[\s\-]?|0[\s\-]?)?[6789](?:[\s\-]?\d){9})(?!\d)/g;
const UPI_RE = /([A-Za-z0-9._\-]{2,64}@[A-Za-z]{2,32})\b/g;
const IFSC_RE = /\b([A-Za-z]{4}0[A-Za-z0-9]{6})\b/g;
const PASSPORT_RE = /\b([A-Z][0-9]{7})\b/g;
const VOTER_RE = /\b([A-Z]{3}[0-9]{7})\b/g;
const DL_RE = /\b([A-Z]{2}\d{2}\s?\d{11})\b/gi;

/** PAN applicant-type codes (3rd char) and status codes (4th char). */
const PAN_ENTITY = new Set(["P", "C", "H", "A", "B", "G", "J", "L", "F", "T"]);
const PAN_STATUS = new Set(["C", "P", "H", "F", "A", "T", "B", "L", "J", "G"]);

function collect(re: RegExp, text: string): Array<{ start: number; end: number; group: string }> {
  re.lastIndex = 0;
  const out: Array<{ start: number; end: number; group: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const group = m[1] ?? full;
    const offsetInFull = m[1] ? full.indexOf(group) : 0;
    const start = m.index + offsetInFull;
    out.push({ start, end: start + group.length, group });
    if (full.length === 0) re.lastIndex++;
  }
  return out;
}

/** Run every Indian detector over normalized text. */
export function detectIndia(norm: NormalizedText): IndiaHit[] {
  const { text } = norm;
  const hits: IndiaHit[] = [];

  for (const { start, end, group } of collect(AADHAAR_RE, text)) {
    const digits = group.replace(/\s/g, "");
    hits.push({
      kind: "aadhaar",
      start,
      end,
      confidence: verhoeffValid(digits) ? 0.95 : 0.55,
    });
  }

  for (const { start, end, group } of collect(PAN_RE, text)) {
    const upper = group.toUpperCase();
    const wellFormed = PAN_ENTITY.has(upper[3]) && PAN_STATUS.has(upper[4]);
    hits.push({ kind: "pan", start, end, confidence: wellFormed ? 0.92 : 0.6 });
  }

  for (const { start, end, group } of collect(PHONE_RE, text)) {
    if (group.replace(/[^\d]/g, "").length < 10) continue;
    hits.push({
      kind: "phone_in",
      start,
      end,
      // Explicit +91 trunk prefix is a stronger signal than a bare run.
      confidence: /^\+?91|^0/.test(group) ? 0.9 : 0.85,
    });
  }

  for (const { start, end, group } of collect(UPI_RE, text)) {
    // A dot after the @ means e-mail, not a UPI handle.
    const afterAt = group.slice(group.indexOf("@") + 1);
    if (afterAt.includes(".")) continue;
    hits.push({ kind: "upi", start, end, confidence: 0.8 });
  }

  for (const { start, end, group } of collect(IFSC_RE, text)) {
    if (group.toUpperCase()[4] === "0") {
      hits.push({ kind: "ifsc", start, end, confidence: 0.9 });
    }
  }

  for (const { start, end } of collect(PASSPORT_RE, text)) {
    hits.push({ kind: "passport", start, end, confidence: 0.75 });
  }

  for (const { start, end } of collect(VOTER_RE, text)) {
    hits.push({ kind: "voter_id", start, end, confidence: 0.75 });
  }

  for (const { start, end } of collect(DL_RE, text)) {
    hits.push({ kind: "driving_licence", start, end, confidence: 0.7 });
  }

  return hits;
}
