/* ------------------------------------------------------------------ *
 * Vision metadata — minimal, privacy-preserving description of the
 * LOCAL inference that produced the detections behind a redaction.
 *
 * Transmitted alongside the sanitized image so the backend can reason
 * about detector provenance WITHOUT ever seeing pixels or text:
 *   model id / version / runtime / backend / latency / detection count
 *   / capture dimensions.
 *
 * NEVER carried: raw screenshots, pixel buffers, OCR plaintext,
 * region text, or any page-derived strings.
 * ------------------------------------------------------------------ */

import type { VisionBackend } from "@/vision/types";

export interface VisionMetadata {
  model: string;
  model_version: string;
  runtime: "browser-local";
  backend: VisionBackend;
  inference_latency_ms: number;
  detections: number;
  capture_width: number;
  capture_height: number;
}

export interface VisionMetadataInput {
  modelId: string;
  /** Model weight variant, e.g. "q8". */
  modelVersion?: string;
  backend: VisionBackend;
  /** End-to-end local inference time (preprocess + inference + post). */
  inferenceLatencyMs: number;
  /** Number of detections the local model returned. */
  detections: number;
  captureWidth: number;
  captureHeight: number;
}

const KNOWN_MODELS: ReadonlySet<string> = new Set(["yolos-tiny"]);
const MAX_LATENCY_MS = 600_000;
const MAX_DIMENSION = 8192;
const MAX_DETECTIONS = 10_000;

export function buildVisionMetadata(input: VisionMetadataInput): VisionMetadata {
  return {
    model: input.modelId,
    model_version: input.modelVersion ?? "q8",
    runtime: "browser-local",
    backend: input.backend,
    inference_latency_ms: Math.round(input.inferenceLatencyMs * 100) / 100,
    detections: Math.floor(input.detections),
    capture_width: Math.floor(input.captureWidth),
    capture_height: Math.floor(input.captureHeight),
  };
}

export interface MetadataValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Strict structural validation. Rejects unknown keys (a metadata object
 * carrying smuggled page text must never pass), unknown models/backends,
 * and out-of-range numerics. Value-free errors only.
 */
export function validateVisionMetadata(metadata: unknown): MetadataValidation {
  const errors: string[] = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, errors: ["metadata must be an object"] };
  }
  const m = metadata as Record<string, unknown>;
  const allowed = new Set([
    "model",
    "model_version",
    "runtime",
    "backend",
    "inference_latency_ms",
    "detections",
    "capture_width",
    "capture_height",
  ]);
  for (const key of Object.keys(m)) {
    if (!allowed.has(key)) errors.push(`unknown metadata key: ${key}`);
  }
  if (typeof m.model !== "string" || !KNOWN_MODELS.has(m.model)) {
    errors.push(`unknown model: ${JSON.stringify(m.model)}`);
  }
  if (typeof m.model_version !== "string" || m.model_version.length === 0 || m.model_version.length > 32) {
    errors.push("model_version must be a short string");
  }
  if (m.runtime !== "browser-local") errors.push(`runtime must be browser-local`);
  if (m.backend !== "webgpu" && m.backend !== "wasm" && m.backend !== "cpu") {
    errors.push(`unknown backend: ${JSON.stringify(m.backend)}`);
  }
  const num = (key: string, min: number, max: number, integer: boolean) => {
    const v = m[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      errors.push(`${key} out of range`);
    }
  };
  num("inference_latency_ms", 0, MAX_LATENCY_MS, false);
  num("detections", 0, MAX_DETECTIONS, true);
  num("capture_width", 1, MAX_DIMENSION, true);
  num("capture_height", 1, MAX_DIMENSION, true);
  return { ok: errors.length === 0, errors };
}
