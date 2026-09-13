// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { VisionEngine } from "@/vision/worker/vision-engine";

/**
 * AT-01 — ON-DEVICE REAL INFERENCE (integration-only, no mocks).
 *
 * Loads the same quantized YOLOS-tiny checkpoint bundled at build time
 * (extension/public/models/yolos-tiny/onnx/model_quantized.onnx) using the
 * exact VisionEngine + detector code the vision worker runs in-browser.
 * Execution is fully local: allowRemoteModels=false + local_model_path is
 * the on-disk extension/public/models directory; onnxruntime-node provides
 * the CPU backend here (in the browser worker it is WebGPU/WASM).
 *
 * Metrics recorded are REAL from a real forward pass — not fixtures or stubs.
 */
const FIXTURE = resolve(process.cwd(), "tests/fixtures/vision/sample-cats.png");
const MODEL_BASE = resolve(process.cwd(), "extension/public/models/");

describe("AT-01 — real local object detection", () => {
  it("loads the model fully offline and detects real objects with measured latency", async () => {
    const engine = new VisionEngine();
    let initInfo: Awaited<ReturnType<typeof engine.init>>;
    initInfo = await engine.init({
      modelBase: MODEL_BASE.endsWith("/") ? MODEL_BASE : MODEL_BASE + "/",
      backend: "cpu",
    });
    expect(engine.initialized).toBe(true);
    expect(initInfo.modelId).toBe("yolos-tiny");

    // Image fixture is a real photo of two cats. Encode it as an RGBA raster.
    const raw = readFileSync(FIXTURE);
    const T = await import("@huggingface/transformers");
    const image = await T.RawImage.fromBlob(new Blob([raw]));
    const { width, height, data } = image;
    const rgba = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);

    const result = await engine.infer({
      id: "at-01",
      width,
      height,
      data: rgba,
      sourceWidth: width,
      sourceHeight: height,
    });

    // Real detections must exist (two cats are present in the frame).
    expect(result.detections.length).toBeGreaterThanOrEqual(1);
    const cats = result.detections.filter((d) => d.label === "cat");
    expect(cats.length).toBeGreaterThanOrEqual(1);

    // Boxes must be image-relative (within the frame), structured and confident.
    for (const d of result.detections) {
      expect(d.bbox.x).toBeGreaterThanOrEqual(0);
      expect(d.bbox.y).toBeGreaterThanOrEqual(0);
      expect(d.bbox.x + d.bbox.width).toBeLessThanOrEqual(width + 1);
      expect(d.bbox.y + d.bbox.height).toBeLessThanOrEqual(height + 1);
      expect(d.confidence).toBeGreaterThanOrEqual(0.5);
      expect(["element", "text", "face", "sensitive"]).toContain(d.type);
    }

    // Latency must be recorded (raw CPU inference — expect hundreds of ms).
    const m = result.metrics;
    expect(m.preprocessMs).toBeGreaterThanOrEqual(0);
    expect(m.inferenceMs).toBeGreaterThan(0);
    expect(m.postprocessMs).toBeGreaterThanOrEqual(0);
    expect(m.totalMs).toBeGreaterThan(0);
    expect(m.backend).toBe("cpu");

    // Print the measured metrics for the report.
    console.log(`[AT-01] detections=${result.detections.length} cats=${cats.length} ` +
      `preprocess=${m.preprocessMs.toFixed(1)}ms inference=${m.inferenceMs.toFixed(1)}ms ` +
      `postprocess=${m.postprocessMs.toFixed(1)}ms total=${m.totalMs.toFixed(1)}ms`);

    await engine.dispose();
    expect(engine.initialized).toBe(false);
  }, 120_000);
});