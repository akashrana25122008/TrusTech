// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { VisionEngine } from "@/vision/worker/vision-engine";

/**
 * Phase 9 §36 — repeated-inference memory smoke test on the real model.
 * Samples in-process RSS around 6 sequential inferences. The bound is
 * deliberately generous (300 MB): this guards against unbounded growth
 * (duplicated sessions, retained rasters), not against GC noise. RSS is
 * GC-sensitive; treat the deltas as approximate.
 */
describe("inference memory stability", () => {
  it("runs 6 sequential inferences without unbounded RSS growth", async () => {
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
    const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);

    const mb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
    // Warmup: the first inference allocates the runtime's memory arenas
    // (observed +~500 MB once, then flat). Steady-state growth is measured
    // after warmup so allocator init is not mistaken for a leak.
    await engine.infer({ id: "mem-warmup", width: iw, height: ih, data, sourceWidth: iw, sourceHeight: ih });
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await engine.infer({ id: `mem-${i}`, width: iw, height: ih, data, sourceWidth: iw, sourceHeight: ih });
      expect(result.detections.length).toBeGreaterThan(0);
      samples.push(mb(process.memoryUsage().rss));
      console.log(`[perf:memory] iter=${i} rss=${samples[i]}MB detections=${result.detections.length}`);
    }
    await engine.dispose();
    const baseline = samples[0];
    const peak = Math.max(...samples);
    const growth = Math.round((peak - baseline) * 100) / 100;
    writeFileSync(
      resolve(process.cwd(), "tests/performance/results-memory.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), runs: samples.length, rssMb: samples, baselineMb: baseline, peakMb: peak, growthMb: growth }, null, 2) + "\n",
    );
    expect(growth).toBeLessThan(300);
  }, 300_000);
});
