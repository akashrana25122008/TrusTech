/* ------------------------------------------------------------------ *
 * Transmission permit — the trust token the network sender requires.
 *
 * Progression (distinct types, §29):
 *   RawCapture ──sanitize──► SanitizedImage ──authorize──►
 *   TransmissionPermit ──transmit──► network (once, bound bytes)
 *
 * A permit binds THREE things together at issue time:
 *   1. the exact sanitized PNG bytes (sha-256),
 *   2. the exact manifest (sha-256 over canonical JSON),
 *   3. an expiry timestamp (default TTL 5 minutes).
 *
 * A permit for image A can never authorize image B: the sender
 * re-hashes the bytes it is about to transmit and compares. Expired
 * permits, substituted manifests, and re-encoded bytes all fail.
 * Permits live in a module-private registry — unforgeable externally.
 * ------------------------------------------------------------------ */

import {
  isSealedSanitizedImage,
  SanitizedImage,
} from "./sanitized-image";
import {
  REDACTION_MANIFEST_VERSION,
  manifestsEqual,
  validateRedactionManifest,
  type RedactionManifest,
} from "./redaction-manifest";
import { validateVisionMetadata } from "./vision-metadata";
import { sha256Hex, sha256Json } from "./integrity";

/** Permit lifetime. Short on purpose: re-authorize, don't hoard. */
export const PERMIT_TTL_MS = 5 * 60 * 1000;

export interface TransmissionPermit {
  readonly id: string;
  /** sha-256 of the sealed sanitized PNG bytes. */
  readonly imageHash: string;
  /** sha-256 of the canonical manifest JSON. */
  readonly manifestHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly regionCount: number;
  readonly manifestVersion: string;
}

export type PermitBlockCode =
  | "NOT_SANITIZED_ARTIFACT"
  | "DISPOSED_ARTIFACT"
  | "UNVERIFIED_IMAGE"
  | "INVALID_MANIFEST"
  | "MANIFEST_MISMATCH"
  | "INVALID_METADATA"
  | "HASH_FAILED";

export interface PermitResult {
  ok: boolean;
  permit?: TransmissionPermit;
  code?: PermitBlockCode;
  /** Value-free reason (safe to log/telemetry). */
  reason: string;
}

const PERMITS = new WeakSet<TransmissionPermit>();
let permitSeq = 0;

export function isLivePermit(value: unknown): value is TransmissionPermit {
  return (
    typeof value === "object" &&
    value !== null &&
    PERMITS.has(value as TransmissionPermit) &&
    (value as TransmissionPermit).expiresAt > Date.now()
  );
}

export interface AuthorizeInput {
  image: unknown;
  /** Presented manifest; defaults to the sealed artifact manifest. */
  manifest?: unknown;
  /** Vision metadata. Required by default (privacy-preserving schema). */
  metadata?: unknown;
  /** Set false only when a stage legitimately has no vision leg. */
  requireMetadata?: boolean;
  now?: number;
}

/**
 * Authorize ONE transmission of ONE sealed artifact. Binds bytes +
 * manifest + expiry. Never throws — every failure is a BLOCK result.
 */
export async function authorizeVisualTransmission(input: AuthorizeInput): Promise<PermitResult> {
  const now = input.now ?? Date.now();
  const deny = (code: PermitBlockCode, reason: string): PermitResult => ({ ok: false, code, reason });

  const image = input.image;
  if (!(image instanceof SanitizedImage)) return deny("NOT_SANITIZED_ARTIFACT", "not a SanitizedImage");
  if (image.disposed) return deny("DISPOSED_ARTIFACT", "disposed SanitizedImage");
  if (!isSealedSanitizedImage(image)) return deny("NOT_SANITIZED_ARTIFACT", "unsealed artifact");
  if (!image.verification || image.verification.ok !== true) return deny("UNVERIFIED_IMAGE", "pixel verification did not pass");

  const manifest = (input.manifest ?? image.manifest) as RedactionManifest;
  const validity = validateRedactionManifest(manifest, { width: image.width, height: image.height });
  if (!validity.ok) return deny("INVALID_MANIFEST", `manifest invalid: ${validity.errors[0]}`);
  if (!manifestsEqual(manifest, image.manifest)) return deny("MANIFEST_MISMATCH", "presented manifest differs from sealed");

  if (input.requireMetadata ?? true) {
    const meta = validateVisionMetadata(input.metadata);
    if (!meta.ok) return deny("INVALID_METADATA", `metadata invalid: ${meta.errors[0]}`);
  }

  let png: Uint8Array;
  try {
    png = image.pngBytes();
  } catch {
    return deny("DISPOSED_ARTIFACT", "could not export sealed bytes");
  }
  let imageHash: string;
  let manifestHash: string;
  try {
    imageHash = await sha256Hex(png);
    manifestHash = await sha256Json(manifest);
  } catch {
    return deny("HASH_FAILED", "integrity hash unavailable");
  }

  const permit: TransmissionPermit = Object.freeze({
    id: `permit_${now.toString(36)}_${(permitSeq++).toString(36)}`,
    imageHash,
    manifestHash,
    issuedAt: now,
    expiresAt: now + PERMIT_TTL_MS,
    regionCount: manifest.regions.length,
    manifestVersion: REDACTION_MANIFEST_VERSION,
  });
  PERMITS.add(permit);
  return { ok: true, permit, reason: `permit ${permit.id} for ${manifest.regions.length} regions` };
}

export interface RevalidateInput {
  permit: unknown;
  image: unknown;
  manifest?: unknown;
  now?: number;
}

/**
 * Re-check a permit against the CURRENT bytes before every send attempt
 * (initial send and every retry). Catches expiry, byte mutation, and
 * manifest substitution between authorize and transmit.
 */
export async function revalidatePermit(input: RevalidateInput): Promise<PermitResult> {
  const now = input.now ?? Date.now();
  const deny = (code: PermitBlockCode, reason: string): PermitResult => ({ ok: false, code, reason });
  const permit = input.permit as TransmissionPermit;
  if (typeof permit !== "object" || permit === null || !PERMITS.has(permit)) {
    return deny("NOT_SANITIZED_ARTIFACT", "unknown permit");
  }
  if (permit.expiresAt <= now) return deny("NOT_SANITIZED_ARTIFACT", "permit expired");
  const image = input.image;
  if (!(image instanceof SanitizedImage) || image.disposed || !isSealedSanitizedImage(image)) {
    return deny("DISPOSED_ARTIFACT", "artifact not sendable");
  }
  let png: Uint8Array;
  try {
    png = image.pngBytes();
  } catch {
    return deny("DISPOSED_ARTIFACT", "could not export sealed bytes");
  }
  let imageHash: string;
  try {
    imageHash = await sha256Hex(png);
  } catch {
    return deny("HASH_FAILED", "integrity hash unavailable");
  }
  if (imageHash !== permit.imageHash) return deny("MANIFEST_MISMATCH", "image bytes changed since permit");
  if (input.manifest !== undefined) {
    let manifestHash: string;
    try {
      manifestHash = await sha256Json(input.manifest);
    } catch {
      return deny("HASH_FAILED", "integrity hash unavailable");
    }
    if (manifestHash !== permit.manifestHash) return deny("MANIFEST_MISMATCH", "manifest changed since permit");
  }
  return { ok: true, permit, reason: `permit ${permit.id} revalidated` };
}
