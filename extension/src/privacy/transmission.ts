/* ------------------------------------------------------------------ *
 * TransmissionFirewall — the single local security boundary before
 * any page-derived network transmission.
 *
 *   inspect → sanitize (rebuild, never mask-in-place) → re-scan →
 *   policy → ALLOW / BLOCK. Fail closed on every error path.
 *
 * Consumes Feature #1 findings (scanText) — never duplicates detection
 * logic. The caller's raw input is never mutated; the sanitized
 * request is a fresh object graph.
 * ------------------------------------------------------------------ */

import { scanText, type FindingType } from "./fusion";
import { detectSecrets, isAuthHeader } from "./secrets";
import { isProbableImagePayload, isImageFieldName } from "./image";
import {
  OUTBOUND_MASK,
  OUTBOUND_LIMITS,
  USER_AUTHORDED_PATHS,
  ALLOWED_HEADERS,
  sensitiveKeyCategory,
  looksLikePersonName,
  looksLikeAddress,
  type FirewallReason,
} from "./policy";

export type FirewallVerdict = "ALLOW" | "BLOCK";

export interface FirewallMetrics {
  inspectMs: number;
  sanitizeMs: number;
  validateMs: number;
  totalMs: number;
  bytesIn: number;
  bytesOut: number;
  redactionCount: number;
}

export interface FirewallDecision {
  decision: FirewallVerdict;
  reason: FirewallReason;
  /** True when a sanitized copy was produced. */
  sanitized: boolean;
  /** True when the final representation passed the second scan. */
  validated: boolean;
  /** PII/secret categories seen (uppercase names, never values). */
  detectedTypes: string[];
  redactionCount: number;
  metrics: FirewallMetrics;
}

export interface OutboundRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body: unknown;
}

export interface SanitizedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface AuthorizedTransmission {
  decision: FirewallDecision;
  /** Present only on ALLOW. */
  request?: SanitizedRequest;
}

/** Uppercase outbound masks for Feature #1 finding types. */
const PII_MASK: Record<FindingType, string> = {
  email: "[EMAIL]",
  phone: "[PHONE]",
  credit_card: "[CARD]",
  ssn: "[SSN]",
  aadhaar: "[AADHAAR]",
  pan: "[PAN]",
  upi: "[UPI]",
  ifsc: "[IFSC]",
  passport: "[PASSPORT]",
  voter_id: "[VOTER]",
  driving_licence: "[LICENCE]",
  ipv4: "[IP]",
  postal: "[POSTAL]",
};

/** Internal fail-closed signal (never escapes with values). */
class BlockSignal {
  constructor(
    readonly reason: FirewallReason,
    readonly types: string[] = [],
  ) {}
}

interface ScanAccumulator {
  types: Set<string>;
  redactions: number;
}

/* ---------------- string scanning ---------------- */

const LATIN_WORD = "[A-ZÀ-Þ][A-Za-zÀ-Þà-þ.'\\-]{1,40}";
const DEVA_WORD = "[\\u0900-\\u097F]{2,40}";
// A captured name must stop before a following label. Two guards: the
// extra word is not itself a known label head ("Mobile" in
// "Mobile Number:"), and not an unknown "Label:" token.
const LATIN_HEADS = "email|phone|mobile|address|aadhaar|pan|number|city|button|submit|search|name";
const DEVA_HEADS = "नंबर|ईमेल|फोन|मोबाइल|पता|आधार|पैन|नाम";
const LATIN_EXTRA = `(?:\\s+(?!(?:${LATIN_HEADS})\\b)(?!${LATIN_WORD}\\s*:)${LATIN_WORD}){0,2}`;
// Note: \b is ASCII-word based, so Devanagari heads use an explicit
// separator lookahead instead.
const DEVA_EXTRA = `(?:\\s+(?!(?:${DEVA_HEADS})(?=[\\s:;,]|$))(?!${DEVA_WORD}\\s*:)${DEVA_WORD}){0,2}`;
const LATIN_NAME = `${LATIN_WORD}${LATIN_EXTRA}`;
const DEVA_NAME = `${DEVA_WORD}${DEVA_EXTRA}`;
const NAME_CUE_RE = new RegExp(
  `(name|naam|full name|pura naam|first name|last name|नाम|पूरा नाम)\\s*[:\\-–]\\s*(${LATIN_NAME}|${DEVA_NAME})`,
  "gi",
);
const ADDRESS_VALUE = `(?:(?!\\b[A-ZÀ-Þ][\\w.'\\-]*\\s*:)(?![\\u0900-\\u097F]{2,40}\\s*:)[^\\n;]){4,160}`;
const ADDRESS_CUE_RE = new RegExp(
  `(address|पता|address line|residential address)\\s*[:\\-–]\\s*(${ADDRESS_VALUE})`,
  "gi",
);

/** Mask sensitive spans inside one string; throws BlockSignal on secrets. */
function sanitizeString(raw: string, pageDerived: boolean, acc: ScanAccumulator, checkSecrets?: boolean): string {
  if (isProbableImagePayload(raw)) {
    throw new BlockSignal("RAW_IMAGE", ["IMAGE"]);
  }
  // User-authored instruction text (task.*) carries the user's own words
  // by design — secrets there are explicit instructions, not scraped
  // leaks. Page-derived secrets always block.
  if (checkSecrets ?? pageDerived) {
    const secrets = detectSecrets(raw);
    if (secrets.length > 0) {
      throw new BlockSignal(
        "SECRET_DETECTED",
        [...new Set(secrets.map((s) => s.kind))],
      );
    }
  }
  let out = raw;
  const findings = scanText(raw);
  // Replace from the end so earlier spans stay valid.
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  for (const f of ordered) {
    const mask = PII_MASK[f.type];
    out = out.slice(0, f.start) + mask + out.slice(f.end);
    acc.types.add(f.type.toUpperCase());
    acc.redactions++;
  }
  if (pageDerived) {
    out = out.replace(NAME_CUE_RE, (_m, cue: string) => {
      acc.types.add("PERSON");
      acc.redactions++;
      return `${cue}: ${OUTBOUND_MASK.PERSON}`;
    });
    out = out.replace(ADDRESS_CUE_RE, (_m, cue: string) => {
      acc.types.add("ADDRESS");
      acc.redactions++;
      return `${cue}: ${OUTBOUND_MASK.ADDRESS}`;
    });
    if (/https?:\/\//.test(out)) out = sanitizeUrlString(out, acc);
  }
  return out;
}

/** Mask PII inside a URL's query and fragment; block embedded secrets. */
export function sanitizeUrlString(raw: string, acc?: ScanAccumulator): string {
  const local: ScanAccumulator = acc ?? { types: new Set(), redactions: 0 };
  const before = local.redactions;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw; // Relative/odd URL — the string scan above already ran.
  }
  if (parsed.username || parsed.password) {
    throw new BlockSignal("SECRET_DETECTED", ["AUTH_HEADER"]);
  }
  for (const [key, value] of Array.from(parsed.searchParams.entries())) {
    const clean = sanitizeString(value, true, local);
    if (clean !== value) parsed.searchParams.set(key, clean);
  }
  if (parsed.hash) {
    const cleanHash = sanitizeString(parsed.hash.slice(1), true, local);
    parsed.hash = cleanHash ? `#${cleanHash}` : "";
  }
  // Least-change principle: untouched URLs pass through byte-identical so
  // downstream URL matching never shifts under sanitization.
  if (local.redactions === before) return raw;
  return parsed.toString();
}

/* ---------------- recursive reconstruction ---------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(
  value: unknown,
  path: string[],
  pageDerived: boolean,
  depth: number,
  acc: ScanAccumulator,
): unknown {
  if (depth > OUTBOUND_LIMITS.depth) throw new BlockSignal("UNKNOWN_CONTENT", ["DEPTH"]);
  // task.* subtrees are user-authored instructions: pattern-scan only,
  // never label/cue masking (the user asked the agent to use this data).
  const derived = pageDerived && !(path.length > 0 && USER_AUTHORDED_PATHS.includes(path[0]));
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Numeric PII (phone/Aadhaar as JSON numbers) must not slip through.
    const asText = String(value);
    const findings = scanText(asText);
    if (findings.length > 0) {
      acc.redactions++;
      for (const f of findings) acc.types.add(f.type.toUpperCase());
      return PII_MASK[findings[0].type];
    }
    return value;
  }
  if (typeof value === "string") return sanitizeString(value, derived, acc, derived);
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    throw new BlockSignal("UNKNOWN_CONTENT", ["OPAQUE"]);
  }
  if (isProbableImagePayload(value)) throw new BlockSignal("RAW_IMAGE", ["IMAGE"]);
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(item, [...path, String(i)], derived, depth + 1, acc));
  }
  if (!isPlainObject(value)) throw new BlockSignal("UNKNOWN_CONTENT", ["OPAQUE"]);

  // Element descriptors ({id, role, ...}): pattern-scan only — label-key
  // masking must never eat UI tokens like "Search".
  const keys = Object.keys(value);
  const isDescriptor = typeof value["role"] === "string" && typeof value["id"] === "string";
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const child = value[key];
    const childPath = [...path, key];
    if (!isDescriptor && isImageFieldName(key) && typeof child === "string" && child.length > 0) {
      throw new BlockSignal("RAW_IMAGE", ["IMAGE"]);
    }
    if (!isDescriptor) {
      const category = sensitiveKeyCategory(key);
      if (!derived) {
        // User-authored subtree: pattern-scan only, no label masking,
        // no secret blocking (explicit user instruction).
        out[key] = sanitizeValue(child, childPath, derived, depth + 1, acc);
        continue;
      }
      if (category === "SECRET" || category === "PASSWORD") {
        if (typeof child === "string" && child.length > 0) {
          throw new BlockSignal("SECRET_DETECTED", [category]);
        }
        out[key] = sanitizeValue(child, childPath, derived, depth + 1, acc);
        continue;
      }
      if (category === "PERSON" && typeof child === "string" && looksLikePersonName(child)) {
        acc.types.add("PERSON");
        acc.redactions++;
        out[key] = OUTBOUND_MASK.PERSON;
        continue;
      }
      if (category === "ADDRESS" && typeof child === "string" && looksLikeAddress(child)) {
        acc.types.add("ADDRESS");
        acc.redactions++;
        out[key] = OUTBOUND_MASK.ADDRESS;
        continue;
      }
    }
    out[key] = sanitizeValue(child, childPath, derived, depth + 1, acc);
  }
  return out;
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  acc: ScanAccumulator,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.trim().toLowerCase();
    if (isAuthHeader(lower)) throw new BlockSignal("SECRET_DETECTED", ["AUTH_HEADER"]);
    if (!ALLOWED_HEADERS.includes(lower)) continue; // drop, don't forward
    if (typeof value !== "string" || value.length > OUTBOUND_LIMITS.headerChars) {
      throw new BlockSignal("POLICY_DENIED", ["HEADER"]);
    }
    const clean = sanitizeString(value, true, acc);
    out[lower] = clean;
  }
  return out;
}

/* ---------------- second-pass validation ---------------- */

/** Re-scan a FINAL serialized representation. Independent of pass one. */
export function validateSerialized(serialized: string): { clean: boolean; types: string[] } {
  const types = new Set<string>();
  for (const f of scanText(serialized)) types.add(f.type.toUpperCase());
  for (const s of detectSecrets(serialized)) types.add(s.kind);
  if (/data:image\/[a-zA-Z+.-]+;base64,/i.test(serialized)) types.add("IMAGE");
  return { clean: types.size === 0, types: [...types] };
}

/* ---------------- the firewall ---------------- */

export class TransmissionFirewall {
  /**
   * Authorize one outbound request. Returns ALLOW with a freshly built
   * sanitized request, or BLOCK with a value-free reason. Never throws.
   */
  async authorize(request: OutboundRequest): Promise<AuthorizedTransmission> {
    const t0 = performance.now();
    const fail = (
      reason: FirewallReason,
      types: string[],
      acc: ScanAccumulator,
      tInspect: number,
      tSanitize: number,
      bytesIn: number,
    ): AuthorizedTransmission => ({
      decision: {
        decision: "BLOCK",
        reason,
        sanitized: false,
        validated: false,
        detectedTypes: [...new Set(types)],
        redactionCount: acc.redactions,
        metrics: {
          inspectMs: round(tInspect),
          sanitizeMs: round(tSanitize),
          validateMs: 0,
          totalMs: round(performance.now() - t0),
          bytesIn,
          bytesOut: 0,
          redactionCount: acc.redactions,
        },
      },
    });

    const acc: ScanAccumulator = { types: new Set(), redactions: 0 };
    let bytesIn = 0;
    try {
      // — inspect —
      const tInspectStart = performance.now();
      if (!request || typeof request !== "object") throw new BlockSignal("POLICY_DENIED", ["SHAPE"]);
      if (typeof request.url !== "string" || typeof request.method !== "string") {
        throw new BlockSignal("POLICY_DENIED", ["SHAPE"]);
      }
      if (!/^https?:\/\//i.test(request.url)) throw new BlockSignal("POLICY_DENIED", ["URL"]);
      if (request.url.length > OUTBOUND_LIMITS.urlChars) throw new BlockSignal("POLICY_DENIED", ["URL"]);
      if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw new BlockSignal("POLICY_DENIED", ["SHAPE"]);
      }
      let rawSerialized: string;
      try {
        rawSerialized = JSON.stringify(request.body) ?? "";
      } catch {
        throw new BlockSignal("UNKNOWN_CONTENT", ["SERIALIZE"]);
      }
      bytesIn = rawSerialized.length;
      if (bytesIn > OUTBOUND_LIMITS.bodyChars) throw new BlockSignal("POLICY_DENIED", ["SIZE"]);
      const tInspect = performance.now() - tInspectStart;

      // — sanitize (rebuild) —
      const tSanitizeStart = performance.now();
      const sanitizedBody = sanitizeValue(request.body, [], true, 0, acc);
      const sanitizedHeaders = sanitizeHeaders(request.headers, acc);
      const sanitizedUrl = sanitizeUrlString(request.url, acc);
      const tSanitize = performance.now() - tSanitizeStart;

      // — validate (second pass over the FINAL representation) —
      const tValidateStart = performance.now();
      const finalSerialized = JSON.stringify({ url: sanitizedUrl, headers: sanitizedHeaders, body: sanitizedBody }) ?? "";
      const check = validateSerialized(finalSerialized);
      const tValidate = performance.now() - tValidateStart;
      if (!check.clean) {
        return fail("SENSITIVE_DATA_REMAINING", check.types, acc, tInspect, tSanitize, bytesIn);
      }

      const bytesOut = finalSerialized.length;
      const total = performance.now() - t0;
      return {
        decision: {
          decision: "ALLOW",
          reason: acc.redactions > 0 ? "SANITIZED" : "CLEAN",
          sanitized: true,
          validated: true,
          detectedTypes: [...acc.types],
          redactionCount: acc.redactions,
          metrics: {
            inspectMs: round(tInspect),
            sanitizeMs: round(tSanitize),
            validateMs: round(tValidate),
            totalMs: round(total),
            bytesIn,
            bytesOut,
            redactionCount: acc.redactions,
          },
        },
        request: { url: sanitizedUrl, method: request.method, headers: sanitizedHeaders, body: sanitizedBody },
      };
    } catch (err) {
      if (err instanceof BlockSignal) {
        return fail(err.reason, [...acc.types, ...err.types], acc, 0, 0, bytesIn);
      }
      return fail("SANITIZATION_FAILED", [...acc.types], acc, 0, 0, bytesIn);
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
