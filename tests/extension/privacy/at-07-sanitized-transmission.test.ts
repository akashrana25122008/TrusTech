// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { VisionEngine } from "@/vision/worker/vision-engine";
import { transmitVisualContext, validateVisualPayload, type VisualTransport } from "@/privacy/visual-transmission";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * AT-07 — VALID SANITIZED TRANSMISSION, end to end (§14):
 *
 *   real fixture PNG → real YOLOS-tiny inference (honest metadata) →
 *   GT regions → redact → pixel-verify → permit → mock HTTPS →
 *   backend-shape validation.
 *
 * Verifies every §14 box: exactly one request; bytes == sanitized;
 * dims; manifest; metadata; task; schema; no raw bytes anywhere.
 * ------------------------------------------------------------------ */

const FIXTURES = resolve(process.cwd(), "tests/fixtures/privacy");
const MODEL_BASE = resolve(process.cwd(), "extension/public/models/");

describe("AT-07 — valid sanitized transmission", () => {
  it("card-checkout fixture traverses the full boundary exactly once", async () => {
    const engine = new VisionEngine();
    await engine.init({ modelBase: MODEL_BASE.endsWith("/") ? MODEL_BASE : MODEL_BASE + "/", backend: "cpu" });

    // 1–2. capture (fixture PNG) + real local vision detection.
    const buf = readFileSync(resolve(FIXTURES, "card-checkout.png"));
    const T = await import("@huggingface/transformers");
    const decoded = await T.RawImage.fromBlob(new Blob([new Uint8Array(buf)]));
    const width = decoded.width as unknown as number;
    const height = decoded.height as unknown as number;
    const rgba = decoded.data instanceof Uint8ClampedArray ? decoded.data : new Uint8ClampedArray(decoded.data);
    const vision = await engine.infer({ id: "at-07", width, height, data: rgba, sourceWidth: width, sourceHeight: height });

    // 3–4. PII regions (fixture ground truth as the detector stand-in;
    //      AT-02 already proved the real DOM scanner hits this GT).
    const gt = JSON.parse(readFileSync(resolve(FIXTURES, "card-checkout.gt.json"), "utf-8"));
    const regions: SensitiveRegion[] = gt.grounds.map((g: { type: string; bbox: { x: number; y: number; width: number; height: number } }) => ({
      type: g.type,
      bbox: { ...g.bbox },
      confidence: 0.9,
      severity: severityFor(g.type as SensitiveRegion["type"], 0.9),
      source: "text",
      sources: ["text"],
      evidence: [],
      image: { width, height },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    }));

    // 5–9. redact → manifest → pixel-verify → sealed artifact.
    const rawBytes = new Uint8ClampedArray(rgba);
    const capture = RawCapture.from(width, height, rgba);
    const { image } = sanitizeImage(capture, regions);
    expect(image.verification.ok).toBe(true);
    const sanitizedPng = image.pngBytes();

    // 10–11. honest vision metadata from the REAL inference above.
    const metadata = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: vision.metrics.backend,
      inferenceLatencyMs: vision.metrics.totalMs,
      detections: vision.detections.length,
      captureWidth: width,
      captureHeight: height,
    });

    // 12. privacy permit.
    const { permit } = await authorizeVisualTransmission({ image, metadata });
    expect(permit).toBeDefined();

    // 13–15. mock HTTPS transport (the network observation point).
    const calls: Array<{ url: string; body: string }> = [];
    const transport: VisualTransport = {
      async post(url: string, body: string) {
        calls.push({ url, body });
        return { ok: true, status: 200 };
      },
    };
    const res = await transmitVisualContext({
      permit,
      image,
      metadata,
      task: { goal: "complete checkout", intent: "payment" },
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });

    // 16–17. response validation + cleanup.
    expect(res.verdict).toBe("ALLOW");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8000/api/agent/vision");

    const body = JSON.parse(calls[0].body);
    expect(validateVisualPayload(body).ok).toBe(true);
    expect(body.task.goal).toBe("complete checkout");
    expect(body.visual_context.width).toBe(width);
    expect(body.visual_context.height).toBe(height);
    expect(body.redaction_manifest).toEqual(image.manifest);
    expect(body.vision_metadata.model).toBe("yolos-tiny");
    expect(body.vision_metadata.detections).toBe(vision.detections.length);

    // Image bytes on the wire ARE the sanitized PNG…
    const wirePng = Buffer.from(body.visual_context.image.split(",")[1], "base64");
    expect(new Uint8Array(wirePng)).toEqual(sanitizedPng);
    // …and are NOT the raw bytes.
    const wireDecoded = await T.RawImage.fromBlob(new Blob([new Uint8Array(wirePng)]));
    const wireData = new Uint8ClampedArray(wireDecoded.data);
    expect(wireData.length).toBe(rawBytes.length);
    let identical = 0;
    for (let i = 0; i < wireData.length; i += 4) {
      if (wireData[i] === rawBytes[i] && wireData[i + 1] === rawBytes[i + 1] && wireData[i + 2] === rawBytes[i + 2]) identical++;
    }
    const total = wireData.length / 4;
    expect(identical).toBeLessThan(total); // redaction changed pixels
    expect(identical).toBeGreaterThan(total * 0.5); // task UI preserved (AT-04 proved byte-exactness)

    console.log(
      `[AT-07] ALLOW requests=1 wireBytes=${calls[0].body.length} ` +
        `regions=${body.redaction_manifest.regions.length} detections=${body.vision_metadata.detections} ` +
        `visionMs=${body.vision_metadata.inference_latency_ms} changed=${(((total - identical) / total) * 100).toFixed(1)}%`,
    );

    image.dispose();
    capture.dispose();
    await engine.dispose();
  }, 180_000);
});
