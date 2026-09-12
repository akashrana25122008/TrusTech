/* ------------------------------------------------------------------ *
 * Indic scripts + offset-preserving normalization for PII detection.
 *
 * All detectors run on NORMALIZED text (NFKC, Indic digits folded to
 * ASCII, invisible format characters removed). Because normalization
 * changes string length, every normalized offset maps back to the
 * original string so findings redact the REAL source text.
 *
 * Extensible: add a new { script, digits, range } entry to support
 * another script — no detector changes required.
 * ------------------------------------------------------------------ */

export type IndicScript =
  | "latin"
  | "devanagari"
  | "bengali"
  | "gurmukhi"
  | "gujarati"
  | "oriya"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "arabic_indic";

export type LanguageHint =
  | "en"
  | "hi"
  | "hinglish"
  | "bn"
  | "pa"
  | "gu"
  | "or"
  | "ta"
  | "te"
  | "kn"
  | "ml"
  | "unknown";

interface ScriptDef {
  script: IndicScript;
  /** [start, end] inclusive code-point range of the script block. */
  range: [number, number];
  /** Code point of the script's zero digit (digits are 0-9 contiguous). */
  zero: number;
  language: LanguageHint;
}

const SCRIPT_DEFS: readonly ScriptDef[] = [
  { script: "devanagari", range: [0x0900, 0x097f], zero: 0x0966, language: "hi" },
  { script: "bengali", range: [0x0980, 0x09ff], zero: 0x09e6, language: "bn" },
  { script: "gurmukhi", range: [0x0a00, 0x0a7f], zero: 0x0a66, language: "pa" },
  { script: "gujarati", range: [0x0a80, 0x0aff], zero: 0x0ae6, language: "gu" },
  { script: "oriya", range: [0x0b00, 0x0b7f], zero: 0x0b66, language: "or" },
  { script: "tamil", range: [0x0b80, 0x0bff], zero: 0x0be6, language: "ta" },
  { script: "telugu", range: [0x0c00, 0x0c7f], zero: 0x0c66, language: "te" },
  { script: "kannada", range: [0x0c80, 0x0cff], zero: 0x0ce6, language: "kn" },
  { script: "malayalam", range: [0x0d00, 0x0d7f], zero: 0x0d66, language: "ml" },
  { script: "arabic_indic", range: [0x0600, 0x06ff], zero: 0x0660, language: "unknown" },
];

/** Invisible format characters stripped during normalization. */
const FORMAT_CHARS = new Set([
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0xfeff, // zero-width no-break space / BOM
  0x00ad, // soft hyphen
]);

export interface NormalizedText {
  /** Detection-ready text (NFKC, ASCII digits, no format chars). */
  text: string;
  /**
   * indexMap[i] = original-string index of normalized char i.
   * Length is text.length + 1; the final entry is the original length
   * (exclusive end sentinel) so normalized [s,e) maps to original
   * [indexMap[s], indexMap[e]).
   */
  indexMap: number[];
}

function scriptOf(code: number): ScriptDef | null {
  for (const def of SCRIPT_DEFS) {
    if (code >= def.range[0] && code <= def.range[1]) return def;
  }
  return null;
}

/** Fold one code point to its normalized form; null = drop the char. */
function foldCodePoint(code: number): string | null {
  if (FORMAT_CHARS.has(code)) return null;
  const def = scriptOf(code);
  if (def && code >= def.zero && code <= def.zero + 9) {
    return String.fromCharCode(0x30 + (code - def.zero));
  }
  return String.fromCodePoint(code);
}

/**
 * Normalize text for detection while preserving an offset map back to
 * the original string. NFKC first (compatibility digits, full-width
 * forms), then Indic-digit folding and format-char stripping.
 */
export function normalizeForDetection(raw: string): NormalizedText {
  const nfkc = raw.normalize("NFKC");
  // Map NFKC output back to raw indices (NFKC can expand chars, so walk
  // both strings; falls back to a monotonic map when ambiguous).
  const nfkcToRaw = alignNfkc(raw, nfkc);

  let text = "";
  const indexMap: number[] = [];
  for (let i = 0; i < nfkc.length; ) {
    const code = nfkc.codePointAt(i)!;
    const folded = foldCodePoint(code);
    const units = code > 0xffff ? 2 : 1;
    if (folded !== null) {
      text += folded;
      for (let k = 0; k < folded.length; k++) indexMap.push(nfkcToRaw[i]);
    }
    i += units;
  }
  indexMap.push(raw.length);
  return { text, indexMap };
}

/**
 * Best-effort alignment of an NFKC string back to raw offsets. Exact for
 * the common case (NFKC is identity on most text); monotonic fallback
 * otherwise so spans never invert.
 */
function alignNfkc(raw: string, nfkc: string): number[] {
  const map: number[] = new Array(nfkc.length).fill(0);
  let r = 0;
  let n = 0;
  // Fast path: identical strings.
  if (raw === nfkc) {
    for (let i = 0; i < nfkc.length; i++) map[i] = i;
    return map;
  }
  while (n < nfkc.length) {
    map[n] = Math.min(r, raw.length);
    if (r < raw.length && raw[r] === nfkc[n]) {
      r++;
      n++;
    } else {
      // Diverged (compatibility expansion): advance the side that is
      // behind by trying a one-char lookahead on either side.
      if (r + 1 < raw.length && raw[r + 1] === nfkc[n]) {
        r += 2;
        n++;
      } else {
        r++;
        if (r >= raw.length || n + 1 >= nfkc.length) n++;
      }
    }
  }
  // Enforce monotonicity.
  for (let i = 1; i < map.length; i++) {
    if (map[i] < map[i - 1]) map[i] = map[i - 1];
  }
  return map;
}

/** Map a normalized [start, end) span back onto the original string. */
export function toOriginalSpan(norm: NormalizedText, start: number, end: number): { start: number; end: number } {
  const s = Math.max(0, Math.min(start, norm.text.length));
  const e = Math.max(s, Math.min(end, norm.text.length));
  return { start: norm.indexMap[s], end: norm.indexMap[e] };
}

/** Dominant script of a segment (for language hints on findings). */
export function detectScript(segment: string): IndicScript {
  const counts = new Map<IndicScript, number>();
  for (const ch of segment) {
    const def = scriptOf(ch.codePointAt(0)!);
    if (!def) continue;
    if (def.script === "arabic_indic") continue; // digits only, not a language signal
    counts.set(def.script, (counts.get(def.script) ?? 0) + 1);
  }
  let best: IndicScript = "latin";
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/** Language hint for a segment, with Hinglish detection (Latin + Hindi cues). */
export function detectLanguage(segment: string, surrounding = ""): LanguageHint {
  const script = detectScript(segment + " " + surrounding);
  if (script !== "latin") {
    return SCRIPT_DEFS.find((d) => d.script === script)?.language ?? "unknown";
  }
  // Latin script: Hinglish when Hindi/romanized cues appear nearby.
  if (/[अ-ह]|aadhar|aadh?aar|mobile|kripya|namaste|dhanyavad|pataa?\b/i.test(surrounding + " " + segment)) {
    if (/aadhar|aadh?aar|mobile|kripya|namaste|dhanyavad/i.test(surrounding + " " + segment)) return "hinglish";
  }
  return "en";
}
