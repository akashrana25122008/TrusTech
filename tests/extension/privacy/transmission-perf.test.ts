// @vitest-environment node
import { describe, it, expect } from "vitest";
import { transmitVisualContext, type VisualTransport } from "@/privacy/visual-transmission";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { TransmissionFirewall } from "@/privacy/transmission";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * Phase 4 §32 — full transmission pipeline performance + boundary
 * overhead. Stages: sanitize (plan+render+verify) / permit+encode /
 * mock network. Plus the text-only firewall baseline for the overhead
 * comparison (without-visual vs with-visual).
 * ------------------------------------------------------------------ */

function scene(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 13 + y * 7) % 256;
      data[i + 1] = (x * 5 + y * 11) % 256;
      data[i + 2] = (x * 3 + y * 17) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function regions(n: number, w: number, h: number): SensitiveRegion[] {
  const types = ["PASSWORD", "CARD_NUMBER", "EMAIL", "FACE", "PAN"] as const;
  return Array.from({ length: n }, (_, i) => ({
    type: types[i % types.length],
    bbox: { x: 20 + ((i * 97) % (w - 160)), y: 20 + ((i * 61) % (h - 120)), width: 80, height: 32 },
    confidence: 0.9,
    severity: "high",
    source: "dom",
    sources: ["dom"],
    evidence: [],
    image: { width: w, height: h },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
  })) as SensitiveRegion[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

describe("visual transmission performance", () => {
  it("full pipeline breakdown + firewall baseline", async () => {
    const W = 640;
    const H = 480;
    const px = scene(W, H);
    const transport: VisualTransport = {
      async post() {
        return { ok: true, status: 200 };
      },
    };
    const meta = () =>
      buildVisionMetadata({
        modelId: "yolos-tiny",
        backend: "cpu",
        inferenceLatencyMs: 1200,
        detections: 2,
        captureWidth: W,
        captureHeight: H,
      });

    const totals: number[] = [];
    const sanitizes: number[] = [];
    const permits: number[] = [];
    const sends: number[] = [];
    const N = 10;
    for (let i = 0; i < N; i++) {
      const capture = RawCapture.from(W, H, px);
      const t0 = performance.now();
      const { image } = sanitizeImage(capture, regions(6, W, H));
      sanitizes.push(performance.now() - t0);
      const tp = performance.now();
      const { permit } = await authorizeVisualTransmission({ image, metadata: meta() });
      permits.push(performance.now() - tp);
      const ts = performance.now();
      const res = await transmitVisualContext({
        permit,
        image,
        metadata: meta(),
        task: { goal: "perf probe" },
        transport,
        baseUrl: "http://localhost:8000",
        allowInsecureLocalhost: true,
      });
      sends.push(performance.now() - ts);
      totals.push(performance.now() - t0);
      expect(res.verdict).toBe("ALLOW");
      image.dispose();
      capture.dispose();
    }

    // Text-only baseline: firewall authorize on a step-shaped payload.
    const firewall = new TransmissionFirewall();
    const base: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const auth = await firewall.authorize({
        url: "http://localhost:8000/api/agent/step",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { task: { goal: "perf probe" }, observation: { url: "https://x.example", visibleText: "hello" } },
      });
      base.push(performance.now() - t0);
      expect(auth.decision.decision).toBe("ALLOW");
    }

    const s = (a: number[]) => [...a].sort((x, y) => x - y);
    const row = (label: string, a: number[]) =>
      console.log(`[perf-tx] ${label.padEnd(22)} n=${N} median=${quantile(s(a), 0.5).toFixed(2)}ms p95=${quantile(s(a), 0.95).toFixed(2)}ms`);
    row("sanitize(plan+render+verify)", sanitizes);
    row("permit(hash bind)", permits);
    row("send(encode+validate+post)", sends);
    row("full visual pipeline", totals);
    row("text-only firewall (base)", base);
    const overhead = quantile(s(totals), 0.5) - quantile(s(base), 0.5);
    console.log(`[perf-tx] boundary overhead vs text-only ≈ ${overhead.toFixed(2)}ms median`);
    expect(quantile(s(totals), 0.95)).toBeLessThan(30000);
  }, 180_000);
});
