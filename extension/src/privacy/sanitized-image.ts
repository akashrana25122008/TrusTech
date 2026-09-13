/* ------------------------------------------------------------------ *
 * Sanitized image artifact — the type-level privacy boundary.
 *
 *   RawCapture ──sanitizeImage()──► SanitizedImage
 *
 * There is deliberately NO boolean flag (`isSanitized`) anywhere: a raw
 * capture and a sanitized image are DIFFERENT TYPES, so passing a raw
 * buffer where a sanitized one is required is a compile-time error, and
 * the transmission gate additionally enforces it at runtime via a
 * module-private seal registry (unforgeable from outside this module).
 *
 * Memory ownership: both artifacts own their buffers. dispose()
 * zero-fills and marks the artifact dead; the gate refuses disposed
 * artifacts. Callers must dispose the RawCapture after sanitizing.
 * ------------------------------------------------------------------ */

import {
  DEFAULT_REDACTION_POLICY,
  type RedactionPolicyConfig,
} from "./redaction-policy";
import { planRedactions, type DroppedRegion, type PlannedRedactions } from "./redaction-planner";
import { renderRedactions } from "./redaction-render";
import { buildManifest, type RedactionManifest } from "./redaction-manifest";
import { verifyRedaction, type PixelVerification } from "./pixel-verify";
import { encodePng } from "./png";
import type { SensitiveRegion } from "./regions";

/** Raw screenshot pixels. Construct explicitly; dispose when done. */
export class RawCapture {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  private dead = false;

  private constructor(width: number, height: number, data: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data;
  }

  static from(width: number, height: number, data: Uint8ClampedArray | Uint8Array): RawCapture {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new SanitizeError("BAD_DIMENSIONS", `bad capture dimensions ${width}x${height}`);
    }
    if (data.length !== width * height * 4) {
      throw new SanitizeError("BAD_BUFFER", `buffer length ${data.length} != ${width}x${height}x4`);
    }
    return new RawCapture(width, height, new Uint8ClampedArray(data));
  }

  get disposed(): boolean {
    return this.dead;
  }

  /** Zero-fill and release. The gate never accepts a disposed capture. */
  dispose(): void {
    this.data.fill(0);
    this.dead = true;
  }
}

/** Fail-closed sanitization error. Never carries pixel data. */
export class SanitizeError extends Error {
  constructor(
    readonly code:
      | "BAD_DIMENSIONS"
      | "BAD_BUFFER"
      | "DISPOSED_INPUT"
      | "RENDER_FAILED"
      | "VERIFY_FAILED"
      | "INTERNAL",
    message: string,
  ) {
    super(`sanitize:${code}: ${message}`);
    this.name = "SanitizeError";
  }
}

/** Sealed artifact. Constructible ONLY via sanitizeImage() (the seal
 *  registry lives in this module and cannot be forged externally). */
export class SanitizedImage {
  readonly width: number;
  readonly height: number;
  readonly manifest: RedactionManifest;
  readonly verification: PixelVerification;
  readonly sanitizeMs: number;
  private readonly pixels: Uint8ClampedArray;
  private dead = false;

  private constructor(
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
    manifest: RedactionManifest,
    verification: PixelVerification,
    sanitizeMs: number,
  ) {
    this.width = width;
    this.height = height;
    this.pixels = pixels;
    this.manifest = manifest;
    this.verification = verification;
    this.sanitizeMs = sanitizeMs;
    SEALED.add(this);
  }

  /** Internal factory — only sanitizeImage() calls this. */
  static seal(
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
    manifest: RedactionManifest,
    verification: PixelVerification,
    sanitizeMs: number,
  ): SanitizedImage {
    return new SanitizedImage(width, height, pixels, manifest, verification, sanitizeMs);
  }

  /** Read-only view for local rendering (preview). Never the raw bytes. */
  get data(): Readonly<Uint8ClampedArray> {
    if (this.dead) throw new SanitizeError("INTERNAL", "disposed artifact");
    return this.pixels;
  }

  get disposed(): boolean {
    return this.dead;
  }

  /** Deterministic PNG bytes for the server-facing protocol. */
  pngBytes(): Uint8Array {
    if (this.dead) throw new SanitizeError("INTERNAL", "disposed artifact");
    return encodePng(this.width, this.height, this.pixels);
  }

  dispose(): void {
    this.pixels.fill(0);
    this.dead = true;
    SEALED.delete(this);
  }
}

/** Module-private seal registry: unforgeable proof of pipeline origin. */
const SEALED = new WeakSet<SanitizedImage>();

/** True only for live artifacts sealed by sanitizeImage() in THIS module. */
export function isSealedSanitizedImage(value: unknown): value is SanitizedImage {
  return value instanceof SanitizedImage && !value.disposed && SEALED.has(value);
}

export interface SanitizeOptions {
  policy?: RedactionPolicyConfig;
}

export interface SanitizeResult {
  image: SanitizedImage;
  plan: PlannedRedactions;
  dropped: DroppedRegion[];
}

/**
 * The ONE canonical sanitization pipeline:
 *   plan → render → manifest (from applied ops) → pixel-verify → seal.
 * Throws SanitizeError on ANY failure (fail closed — no partial artifact
 * ever escapes). Empty region lists yield a verified-clean artifact.
 */
export function sanitizeImage(
  raw: RawCapture,
  regions: readonly SensitiveRegion[],
  options: SanitizeOptions = {},
): SanitizeResult {
  const t0 = performance.now();
  if (!(raw instanceof RawCapture) || raw.disposed) {
    throw new SanitizeError("DISPOSED_INPUT", "raw capture missing or disposed");
  }
  const policy = options.policy ?? DEFAULT_REDACTION_POLICY;

  const plan = planRedactions(regions, { width: raw.width, height: raw.height }, policy);

  let rendered;
  try {
    rendered = renderRedactions({ width: raw.width, height: raw.height, data: raw.data }, plan.operations, policy);
  } catch (err) {
    throw new SanitizeError("RENDER_FAILED", err instanceof Error ? err.message : String(err));
  }

  const manifest = buildManifest(rendered.applied);
  const verification = verifyRedaction(
    { width: raw.width, height: raw.height, data: raw.data },
    { width: rendered.width, height: rendered.height, data: rendered.data },
    rendered.applied,
    manifest,
    policy,
  );
  if (!verification.ok) {
    throw new SanitizeError("VERIFY_FAILED", verification.failures.join("; "));
  }

  const image = SanitizedImage.seal(
    rendered.width,
    rendered.height,
    rendered.data,
    manifest,
    verification,
    Math.round((performance.now() - t0) * 100) / 100,
  );
  return { image, plan, dropped: plan.dropped };
}
