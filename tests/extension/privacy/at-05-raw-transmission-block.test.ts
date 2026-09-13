// @vitest-environment node
import { describe, it, expect } from "vitest";
import { transmitVisualContext, type VisualTransport } from "@/privacy/visual-transmission";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";

/* ------------------------------------------------------------------ *
 * AT-05 — RAW / UNSANITIZED TRANSMISSION BLOCK (acceptance).
 *
 * Every raw representation through the SUPPORTED sender API must fail
 * with the transport NEVER invoked (request count = 0, observed on a
 * recording transport — not on the sender's word alone).
 * ------------------------------------------------------------------ */

function recordingTransport(): { transport: VisualTransport; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    transport: {
      async post(url: string, body: string) {
        calls.push({ url, bytes: body.length });
        return { ok: true, status: 200 };
      },
    },
  };
}

function rawCapture(): RawCapture {
  const data = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) % 256;
  return RawCapture.from(64, 48, data);
}

function metadata() {
  return buildVisionMetadata({
    modelId: "yolos-tiny",
    backend: "cpu",
    inferenceLatencyMs: 40,
    detections: 1,
    captureWidth: 64,
    captureHeight: 48,
  });
}

const TASK = { goal: "at-05 probe" };
const NET = { baseUrl: "http://localhost:8000", allowInsecureLocalhost: true } as const;

describe("AT-05 — raw image can never reach the sender", () => {
  it("blocks ImageBitmap / Blob / ArrayBuffer / base64 / encoded-raw with 0 requests", async () => {
    const { transport, calls } = recordingTransport();
    const raw = rawCapture();
    const meta = metadata();

    // Encoded RAW image (PNG of the raw capture — the dangerous shape:
    // valid image bytes that were never sanitized).
    const { image: sealed } = sanitizeImage(raw, []);
    const rawPng = sealed.pngBytes();
    sealed.dispose();

    const attempts: Array<[string, unknown]> = [
      ["ImageBitmap-like", { __tag: "ImageBitmap", width: 64, height: 48 }],
      ["Blob", new Blob([new Uint8Array(raw.data)])],
      ["ArrayBuffer", raw.data.buffer.slice(0)],
      ["Uint8Array", new Uint8Array(raw.data)],
      ["base64", Buffer.from(raw.data).toString("base64")],
      ["raw data-url", `data:image/png;base64,${Buffer.from(rawPng).toString("base64")}`],
      ["RawCapture", raw],
      ["encoded raw PNG bytes", rawPng],
    ];

    const log: string[] = [];
    for (const [name, payload] of attempts) {
      const res = await transmitVisualContext({
        permit: undefined,
        image: payload,
        metadata: meta,
        task: TASK,
        transport,
        ...NET,
      });
      log.push(`${name}: ${res.verdict}/${res.code}`);
      expect(res.verdict, name).toBe("BLOCK");
      expect(res.transmitted, name).toBe(false);
    }

    // Forged permit + raw image.
    const forged = await transmitVisualContext({
      permit: { id: "permit_forged", imageHash: "0".repeat(64), manifestHash: "0".repeat(64) },
      image: raw,
      metadata: meta,
      task: TASK,
      transport,
      ...NET,
    });
    expect(forged.verdict).toBe("BLOCK");
    log.push(`forged permit + raw: ${forged.verdict}/${forged.code}`);

    expect(calls).toHaveLength(0);
    console.log("[AT-05] network requests observed: 0");
    for (const line of log) console.log(`[AT-05]   BLOCK ${line}`);
    raw.dispose();
  });
});
