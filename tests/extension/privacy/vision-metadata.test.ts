import { describe, it, expect } from "vitest";
import { buildVisionMetadata, validateVisionMetadata } from "@/privacy/vision-metadata";

/* Phase 4 §7 — minimal privacy-preserving vision metadata. */

describe("vision-metadata.ts", () => {
  it("builds the canonical metadata shape", () => {
    const m = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "webgpu",
      inferenceLatencyMs: 42.456,
      detections: 5,
      captureWidth: 1280,
      captureHeight: 720,
    });
    expect(m).toEqual({
      model: "yolos-tiny",
      model_version: "q8",
      runtime: "browser-local",
      backend: "webgpu",
      inference_latency_ms: 42.46,
      detections: 5,
      capture_width: 1280,
      capture_height: 720,
    });
  });

  it("validates a well-formed object", () => {
    const m = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "cpu",
      inferenceLatencyMs: 10,
      detections: 0,
      captureWidth: 64,
      captureHeight: 48,
    });
    expect(validateVisionMetadata(m)).toEqual({ ok: true, errors: [] });
  });

  it("rejects smuggled keys (no OCR text / page strings allowed)", () => {
    const m = {
      ...buildVisionMetadata({
        modelId: "yolos-tiny",
        backend: "cpu",
        inferenceLatencyMs: 10,
        detections: 1,
        captureWidth: 64,
        captureHeight: 48,
      }),
      ocr_text: "4111 1111 1111 1111",
    };
    const v = validateVisionMetadata(m);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("ocr_text"))).toBe(true);
  });

  it("rejects unknown models/backends/runtimes and bad ranges", () => {
    const base = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "cpu",
      inferenceLatencyMs: 10,
      detections: 1,
      captureWidth: 64,
      captureHeight: 48,
    });
    expect(validateVisionMetadata({ ...base, model: "gpt-4v" }).ok).toBe(false);
    expect(validateVisionMetadata({ ...base, backend: "tpu" }).ok).toBe(false);
    expect(validateVisionMetadata({ ...base, runtime: "cloud" }).ok).toBe(false);
    expect(validateVisionMetadata({ ...base, detections: -1 }).ok).toBe(false);
    expect(validateVisionMetadata({ ...base, capture_width: 0 }).ok).toBe(false);
    expect(validateVisionMetadata({ ...base, inference_latency_ms: -5 }).ok).toBe(false);
    expect(validateVisionMetadata(null).ok).toBe(false);
    expect(validateVisionMetadata([]).ok).toBe(false);
  });

  it("carries no pixel or text fields by construction", () => {
    const m = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "wasm",
      inferenceLatencyMs: 100,
      detections: 3,
      captureWidth: 640,
      captureHeight: 480,
    });
    expect(Object.keys(m).sort()).toEqual(
      ["backend", "capture_height", "capture_width", "detections", "inference_latency_ms", "model", "model_version", "runtime"],
    );
  });
});
