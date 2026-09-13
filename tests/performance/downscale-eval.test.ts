// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { VisionEngine } from "@/vision/worker/vision-engine";
import { downscaleRaster } from "@/vision/preprocess";

/**
 * Phase 9 §11 — measure inference across capture downscale candidates on the
 * real model (sample-cats.png, 622x412, 2 known cats). The model processor
 * resizes to its own fixed input, so this quantifies what capture resolution
 * actually buys: transfer bytes + preprocess time vs detection stability.
 */
describe("capture downscale evaluation", () => {
  it("measures prep/inference/detections at maxEdge 320 / 480 / native", async () => {
    const engine = new VisionEngine();
    await engine.init({
      modelBase: (() => {
        const base = resolve(process.cwd(), "extension/public/models/");
        return base.endsWith("/") ? base : base + "/";
      })(),
      backend: "cpu",
    });
    const raw = readFileSync(resolve(process.cwd(), "tests/fixtures/vision/sample-cats.png"));
    const T = await import("@huggingface/transformers");
    const image = await T.RawImage.fromBlob(new Blob([new Uint8Array(raw)]));
    const iw = image.width as unknown as number;
    const ih = image.height as unknown as number;
    const full = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);

    const rows: Array<{
      maxEdge: number;
      width: number;
      height: number;
      transferBytes: number;
      prepMs: number;
      inferenceMs: number;
      detections: number;
      cats: number;
    }> = [];
    for (const maxEdge of [320, 480, 1333]) {
      const raster = downscaleRaster({ width: iw, height: ih, data: full }, maxEdge);
      for (let rep = 0; rep < 2; rep++) {
        const t0 = performance.now();
        const result = await engine.infer({
          id: `downscale-${maxEdge}-${rep}`,
          width: raster.width,
          height: raster.height,
          data: raster.data,
          sourceWidth: raster.width,
          sourceHeight: raster.height,
        });
        void t0;
        const cats = result.detections.filter((d) => d.label === "cat").length;
        rows.push({
          maxEdge,
          width: raster.width,
          height: raster.height,
          transferBytes: raster.data.byteLength,
          prepMs: Math.round(result.metrics.preprocessMs * 100) / 100,
          inferenceMs: Math.round(result.metrics.inferenceMs * 100) / 100,
          detections: result.detections.length,
          cats,
        });
        console.log(
          `[perf:downscale] maxEdge=${maxEdge} ${raster.width}x${raster.height} ` +
            `bytes=${raster.data.byteLength} prep=${result.metrics.preprocessMs.toFixed(1)}ms ` +
            `infer=${result.metrics.inferenceMs.toFixed(0)}ms detections=${result.detections.length} cats=${cats}/2`,
        );
      }
    }
    await engine.dispose();
    writeFileSync(
      resolve(process.cwd(), "tests/performance/results-downscale.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), image: "sample-cats.png", native: `${iw}x${ih}`, rows }, null, 2) + "\n",
    );
    // Detection stability gate: every candidate must still see both known cats.
    expect(rows.every((r) => r.cats >= 2)).toBe(true);
  }, 300_000);
});
