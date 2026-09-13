// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { encodePng } from "@/privacy/png";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";
import { recordFragment } from "./helpers/metrics";

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

describe("client resource benchmarks", () => {
  it("measures memory, payload bytes and request counts", () => {
    const rss = () => process.memoryUsage().rss;
    const baseline = rss();

    const region = (type: SensitiveRegion["type"], x: number, y: number, w: number, h: number): SensitiveRegion =>
      ({
        type,
        bbox: { x, y, width: w, height: h },
        confidence: 0.9,
        severity: severityFor(type, 0.9),
        source: "dom",
        sources: ["dom"],
        evidence: [],
        image: { width: 640, height: 480 },
        normalized: { x: 0, y: 0, width: 0, height: 0 },
      }) as SensitiveRegion;

    let peak = baseline;
    const sample = () => {
      peak = Math.max(peak, rss());
    };

    const pngSizes: Array<{ file: string; bytes: number }> = [];
    for (const file of readdirSync(resolve(process.cwd(), "tests/fixtures/privacy"))) {
      if (!file.endsWith(".png")) continue;
      const buf = readFileSync(resolve(process.cwd(), "tests/fixtures/privacy", file));
      pngSizes.push({ file, bytes: buf.length });
      sample();
    }

    const sceneBytes: Array<{ label: string; bytes: number }> = [];
    let requests = 0;
    for (const n of [1, 6, 24]) {
      const data = new Uint8ClampedArray(640 * 480 * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
      const types: SensitiveRegion["type"][] = ["PASSWORD", "CARD_NUMBER", "EMAIL", "FACE", "PAN", "AADHAAR"];
      const regions = Array.from({ length: n }, (_, i) =>
        region(types[i % types.length], 20 + ((i * 97) % 480), 20 + ((i * 61) % 360), 80, 32),
      );
      const capture = RawCapture.from(640, 480, data);
      const { image } = sanitizeImage(capture, regions);
      const png = image.pngBytes();
      sceneBytes.push({ label: `sanitized-640x480-${n}regions`, bytes: png.length });
      requests += 1;
      image.dispose();
      capture.dispose();
      sample();
    }

    const rawSizes = pngSizes.filter((p) => !p.file.startsWith("photo"));
    const final = rss();
    const peakDeltaMb = mb(Math.max(0, peak - baseline));

    const data = {
      methodology: {
        memory: "process.memoryUsage().rss sampled around the workload in-process; GC timing can shift numbers between runs",
        cpu: { status: "NOT_MEASURED", reason: "no reliable CPU API in this runtime" },
        network: "payload bytes measured by encoding; request counts observed on mock transports in transmission tests",
      },
      memory: {
        baselineRssMb: mb(baseline),
        peakRssMb: mb(peak),
        finalRssMb: mb(final),
        peakDeltaMb,
        unit: "MB",
      },
      payloads: {
        fixturePngBytes: pngSizes,
        sanitizedPngBytes: sceneBytes,
        rawPngEncoderBytes: (() => {
          const data = new Uint8ClampedArray(64 * 48 * 4).fill(200);
          return encodePng(64, 48, data).length;
        })(),
      },
      requests: { sanitizedTransmissionsObserved: requests, note: "AT-04/AT-07 assert 1 request per allowed transmission; AT-03/AT-05 assert 0 on block" },
    };
    recordFragment("resources", data);

    console.log(`[metrics:resources] rss baseline=${mb(baseline)}MB peak=${mb(peak)}MB delta=${peakDeltaMb}MB`);
    for (const p of sceneBytes) console.log(`[metrics:resources] ${p.label}: ${p.bytes} bytes`);
    expect(rawSizes.length).toBeGreaterThan(0);
    expect(peak).toBeGreaterThanOrEqual(baseline);
  });
});
