// @vitest-environment node
import { describe, it, expect } from "vitest";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * Phase 3 §26 — performance measurement (no optimization before
 * measuring). Reports median/p95 + sample count for plan / sanitize /
 * verify stages on a representative scene, plus few-vs-many regions.
 * ------------------------------------------------------------------ */

const W = 640;
const H = 480;

function makeScene(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = (x * 13 + y * 7) % 256;
      data[i + 1] = (x * 5 + y * 11) % 256;
      data[i + 2] = (x * 3 + y * 17) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

const TYPES = ["PASSWORD", "CARD_NUMBER", "AADHAAR", "PAN", "EMAIL", "PHONE", "UPI", "IFSC", "FACE"] as const;

function makeRegions(n: number): SensitiveRegion[] {
  const out: SensitiveRegion[] = [];
  for (let i = 0; i < n; i++) {
    const type = TYPES[i % TYPES.length];
    out.push({
      type,
      bbox: { x: 20 + ((i * 97) % 480), y: 20 + ((i * 61) % 360), width: 60 + (i % 5) * 20, height: 24 + (i % 3) * 12 },
      confidence: 0.9,
      severity: "high",
      source: "dom",
      sources: ["dom"],
      evidence: [],
      image: { width: W, height: H },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    } as SensitiveRegion);
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

describe("redaction performance", () => {
  it("measures plan/sanitize/verify latencies (few vs many regions)", () => {
    const scene = makeScene();
    const report: Record<string, { n: number; median: number; p95: number }> = {};

    for (const [label, count] of [["few(3)", 3], ["many(48)", 48]] as const) {
      const totals: number[] = [];
      const plans: number[] = [];
      const verifies: number[] = [];
      const N = 15;
      for (let i = 0; i < N; i++) {
        const capture = RawCapture.from(W, H, scene);
        const { image, plan } = sanitizeImage(capture, makeRegions(count));
        plans.push(plan.plannedMs);
        verifies.push(image.verification.verifyMs);
        totals.push(image.sanitizeMs);
        image.dispose();
        capture.dispose();
      }
      const s = (a: number[]) => [...a].sort((x, y) => x - y);
      report[`${label}/total`] = { n: N, median: quantile(s(totals), 0.5), p95: quantile(s(totals), 0.95) };
      report[`${label}/plan`] = { n: N, median: quantile(s(plans), 0.5), p95: quantile(s(plans), 0.95) };
      report[`${label}/verify`] = { n: N, median: quantile(s(verifies), 0.5), p95: quantile(s(verifies), 0.95) };
    }

    console.log("[perf] redaction latencies (ms, 640x480):");
    for (const [k, v] of Object.entries(report)) {
      console.log(`[perf]   ${k.padEnd(16)} n=${v.n} median=${v.median.toFixed(2)} p95=${v.p95.toFixed(2)}`);
    }
    // Sanity bounds (generous — this is measurement, not a race).
    expect(report["few(3)/total"].p95).toBeLessThan(5000);
    expect(report["many(48)/total"].p95).toBeLessThan(15000);
  }, 180_000);
});
