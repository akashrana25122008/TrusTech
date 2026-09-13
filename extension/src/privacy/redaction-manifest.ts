/* ------------------------------------------------------------------ *
 * Redaction manifest — the canonical, minimal, stable protocol record
 * of EXACTLY what was painted onto the sanitized image.
 *
 * Built ONLY from the planner's RedactionOperation[] (never authored
 * by hand in the pipeline), so manifest/image divergence is impossible
 * by construction. The transmission gate re-validates every manifest
 * before allowing a send; the server validates it again (§19).
 *
 * Coordinate convention: sanitized-image pixel box [x, y, w, h].
 * ------------------------------------------------------------------ */

import { isRedactionMethod, type RedactionMethod } from "./redaction-policy";
import type { SensitiveType } from "./regions";
import type { RedactionOperation } from "./redaction-planner";

export const REDACTION_MANIFEST_VERSION = "1" as const;

export interface RedactionManifestRegion {
  id: string;
  type: SensitiveType;
  method: RedactionMethod;
  bbox: [number, number, number, number];
}

export interface RedactionManifest {
  version: typeof REDACTION_MANIFEST_VERSION;
  regions: RedactionManifestRegion[];
}

/** Build the manifest from the operations that were ACTUALLY applied
 *  (renderer output), never from the pre-render plan alone. */
export function buildManifest(applied: readonly RedactionOperation[]): RedactionManifest {
  return {
    version: REDACTION_MANIFEST_VERSION,
    regions: applied.map((op) => ({ id: op.id, type: op.type, method: op.method, bbox: [...op.bbox] as [number, number, number, number] })),
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^r[1-9][0-9]*$/;
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "FACE",
  "PASSWORD",
  "CARD_NUMBER",
  "AADHAAR",
  "PAN",
  "UPI",
  "PHONE",
  "EMAIL",
  "IFSC",
  "PASSPORT",
  "VOTER_ID",
  "DRIVING_LICENSE",
  "SSN",
]);

/** Strict validator: version, ids, types, methods, bboxes, ranges,
 *  duplicates, counts. Fail-closed — any error → reject. */
export function validateRedactionManifest(
  manifest: unknown,
  image?: { width: number; height: number },
  limits: { maxRegions?: number; maxDimension?: number } = {},
): ManifestValidation {
  const errors: string[] = [];
  const maxRegions = limits.maxRegions ?? 500;
  const maxDimension = limits.maxDimension ?? 8192;

  if (!manifest || typeof manifest !== "object") return { ok: false, errors: ["manifest must be an object"] };
  const m = manifest as Record<string, unknown>;
  if (m.version !== REDACTION_MANIFEST_VERSION) {
    return { ok: false, errors: [`unsupported manifest version: ${JSON.stringify(m.version)}`] };
  }
  if (!Array.isArray(m.regions)) return { ok: false, errors: ["manifest.regions must be an array"] };
  if (m.regions.length > maxRegions) {
    return { ok: false, errors: [`too many regions (${m.regions.length} > ${maxRegions})`] };
  }

  const seen = new Set<string>();
  m.regions.forEach((entry: unknown, i: number) => {
    const where = `regions[${i}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${where} must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) errors.push(`${where}.id must match rN (got ${JSON.stringify(e.id)})`);
    else if (seen.has(e.id)) errors.push(`${where}.id duplicates ${e.id}`);
    else seen.add(e.id);
    if (typeof e.type !== "string" || !KNOWN_TYPES.has(e.type)) errors.push(`${where}.type unknown: ${JSON.stringify(e.type)}`);
    if (!isRedactionMethod(e.method)) errors.push(`${where}.method unsupported: ${JSON.stringify(e.method)}`);
    const bbox = e.bbox;
    const badBox =
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > maxDimension);
    if (badBox) {
      errors.push(`${where}.bbox must be [x,y,w,h] non-negative integers (got ${JSON.stringify(bbox)})`);
    } else {
      const [x, y, w, h] = bbox as [number, number, number, number];
      if (w <= 0 || h <= 0) errors.push(`${where}.bbox must have positive size`);
      if (image) {
        if (x >= image.width || y >= image.height) errors.push(`${where}.bbox origin outside image`);
        if (x + w > image.width || y + h > image.height) errors.push(`${where}.bbox extends outside image`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/** Deep-equality check between the sealed artifact manifest and the one
 *  presented at the gate — catches manifest substitution. */
export function manifestsEqual(a: RedactionManifest, b: RedactionManifest): boolean {
  if (a.version !== b.version || a.regions.length !== b.regions.length) return false;
  const key = (r: RedactionManifestRegion) => `${r.id}|${r.type}|${r.method}|${r.bbox.join(",")}`;
  const sortedA = [...a.regions].map(key).sort();
  const sortedB = [...b.regions].map(key).sort();
  return sortedA.every((k, i) => k === sortedB[i]);
}
