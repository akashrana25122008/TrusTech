// @vitest-environment node
import { describe, it, expect } from "vitest";
import { transmitVisualContext, buildVisualPayload, type VisualTransport } from "@/privacy/visual-transmission";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * Phase 4 §15 — raw-vs-sanitized byte proof on CONTENT, not identity:
 * the payload must contain the sanitized bytes and must never contain
 * the raw bytes. Decodes the wire PNG and compares pixel-for-pixel.
 * ------------------------------------------------------------------ */

function scene(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(96 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      data[i] = (x * 3 + y) % 256;
      data[i + 1] = (x + y * 5) % 256;
      data[i + 2] = (x * 7 + y * 2) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function region(): SensitiveRegion {
  return {
    type: "CARD_NUMBER",
    bbox: { x: 20, y: 20, width: 56, height: 24 },
    confidence: 0.99,
    severity: "high",
    source: "text",
    sources: ["text"],
    evidence: [],
    image: { width: 96, height: 64 },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
  } as SensitiveRegion;
}

describe("raw vs sanitized bytes", () => {
  it("payload carries sanitizedBytes and never rawBytes", async () => {
    const pixels = scene();
    const rawBytes = new Uint8ClampedArray(pixels);
    const capture = RawCapture.from(96, 64, pixels);
    const { image } = sanitizeImage(capture, [region()]);
    const meta = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "cpu",
      inferenceLatencyMs: 30,
      detections: 0,
      captureWidth: 96,
      captureHeight: 64,
    });
    const { permit } = await authorizeVisualTransmission({ image, metadata: meta });

    const bodies: string[] = [];
    const transport: VisualTransport = {
      async post(_url: string, body: string) {
        bodies.push(body);
        return { ok: true, status: 200 };
      },
    };
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: { goal: "byte proof" },
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });
    expect(res.verdict).toBe("ALLOW");
    expect(bodies).toHaveLength(1);

    const payload = JSON.parse(bodies[0]);
    const T = await import("@huggingface/transformers");
    const decode = async (dataUrl: string) => {
      const png = Buffer.from(dataUrl.split(",")[1], "base64");
      const img = await T.RawImage.fromBlob(new Blob([new Uint8Array(png)]));
      return new Uint8ClampedArray(img.data);
    };

    // The payload image decodes to EXACTLY the sealed sanitized pixels.
    const wire = await decode(payload.visual_context.image);
    expect(wire).toEqual(new Uint8ClampedArray(image.data));

    // rawBytes !== sanitizedBytes where redaction was required…
    const sealed = new Uint8ClampedArray(image.data);
    let diff = 0;
    for (let i = 0; i < sealed.length; i += 4) {
      if (sealed[i] !== rawBytes[i] || sealed[i + 1] !== rawBytes[i + 1] || sealed[i + 2] !== rawBytes[i + 2]) diff++;
    }
    expect(diff).toBeGreaterThan(0);

    // …and the wire image never equals the raw capture.
    let wireVsRaw = 0;
    for (let i = 0; i < wire.length; i += 4) {
      if (wire[i] !== rawBytes[i] || wire[i + 1] !== rawBytes[i + 1] || wire[i + 2] !== rawBytes[i + 2]) wireVsRaw++;
    }
    expect(wireVsRaw).toBe(diff);

    // Sanity: the double-width check — payload built directly matches too.
    const direct = buildVisualPayload({ goal: "byte proof" }, image, image.manifest, meta);
    expect(JSON.parse(JSON.stringify(direct)).visual_context.image).toBe(payload.visual_context.image);

    console.log(`[bytes] pixels=${sealed.length / 4} redacted=${diff} wire==sanitized=true wire==raw=false`);
    image.dispose();
    capture.dispose();
  });
});
