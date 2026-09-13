// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { ImageTransmissionGate } from "@/privacy/image-gate";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * AT-03 — RAW IMAGE BLOCKING (acceptance, no mocks in the gate path).
 *
 *   raw screenshot ──► attempt transmission ──► gate ──► BLOCK
 *
 * Passes ONLY when no network request occurs for any raw-shaped input
 * through the supported transmission surface. The fetch spy is the
 * network observation: zero calls == nothing left the device.
 * ------------------------------------------------------------------ */

function rawCapture(w = 64, h = 48): RawCapture {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) % 256;
  return RawCapture.from(w, h, data);
}

describe("AT-03 — raw image can never leave", () => {
  it("blocks every raw-shaped transmission attempt with zero network calls", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const gate = new ImageTransmissionGate({ baseUrl: "http://localhost:8000", fetchFn });
    const attempts: Array<{ name: string; payload: unknown }> = [];

    const raw = rawCapture();
    attempts.push({ name: "RawCapture object", payload: raw });
    attempts.push({ name: "raw RGBA bytes", payload: new Uint8ClampedArray(raw.data) });
    attempts.push({ name: "raw ArrayBuffer", payload: raw.data.buffer.slice(0) });
    attempts.push({ name: "raw data-url string", payload: "data:image/png;base64," + "QUJD".repeat(200) });
    attempts.push({ name: "raw base64 blob", payload: "QUJD".repeat(200) });
    attempts.push({ name: "raw Blob", payload: new Blob([new Uint8Array(raw.data)]) });
    attempts.push({ name: "FormData upload", payload: { image: new Blob(["x"]), manifest: null } });
    attempts.push({
      name: "extension message with screenshot",
      payload: { type: "CTX_SEND", payload: { screenshot: "data:image/png;base64,QUJD" } },
    });

    // A sanitized-then-disposed artifact must also block (no use-after-dispose).
    const regions: SensitiveRegion[] = [
      {
        type: "PASSWORD",
        bbox: { x: 4, y: 4, width: 16, height: 8 },
        confidence: 0.96,
        severity: "high",
        source: "dom",
        sources: ["dom"],
        evidence: [],
        image: { width: 64, height: 48 },
        normalized: { x: 0, y: 0, width: 0, height: 0 },
      },
    ];
    const { image: sealed } = sanitizeImage(raw, regions);
    sealed.dispose();
    attempts.push({ name: "disposed SanitizedImage", payload: sealed });

    // Forged artifact (never passed the pipeline).
    attempts.push({
      name: "forged artifact",
      payload: { width: 64, height: 48, manifest: { version: "1", regions: [] }, verification: { ok: true } },
    });

    const log: string[] = [];
    for (const a of attempts) {
      const res = await gate.sendSanitized(a.payload);
      log.push(`${a.name}: ${res.verdict} (${res.code ?? "ok"})`);
      expect(res.verdict, a.name).toBe("BLOCK");
      expect(res.transmitted, a.name).toBe(false);
    }

    // THE network observation: nothing was ever sent.
    expect(fetchFn).not.toHaveBeenCalled();

    console.log("[AT-03] attempts blocked, fetch calls: 0");
    for (const line of log) console.log(`[AT-03]   BLOCK ${line}`);
    raw.dispose();
  });
});
