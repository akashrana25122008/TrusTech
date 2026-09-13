// @vitest-environment node
import { describe, it, expect } from "vitest";
import { transmitVisualContext, type VisualTransport } from "@/privacy/visual-transmission";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * AT-06 — NO SANITIZED VERDICT, NO NETWORK (the judge-facing matrix).
 *
 *   A  no sanitized verdict      → BLOCK, 0 requests
 *   B  sanitized but unverified  → BLOCK, 0 requests  (unverifiable by
 *      construction — sanitizeImage never yields one; approximated by a
 *      disposed artifact + a tampered-verification forgery, both BLOCK)
 *   C  manifest invalid          → BLOCK, 0 requests
 *   D  valid artifact+manifest+verification → ALLOW, 1 request
 *
 * The transport is a recorder: every row asserts on observed requests.
 * ------------------------------------------------------------------ */

function recordingTransport(status = 200): { transport: VisualTransport; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  return {
    calls,
    transport: {
      async post(url: string, body: string) {
        calls.push({ url, body });
        return { ok: status >= 200 && status < 300, status };
      },
    },
  };
}

function raw() {
  const data = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  return RawCapture.from(64, 48, data);
}

function region(): SensitiveRegion {
  return {
    type: "PASSWORD",
    bbox: { x: 10, y: 10, width: 20, height: 10 },
    confidence: 0.96,
    severity: "high",
    source: "dom",
    sources: ["dom"],
    evidence: [],
    image: { width: 64, height: 48 },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
  } as SensitiveRegion;
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

const TASK = { goal: "at-06 matrix" };
const NET = { baseUrl: "http://localhost:8000", allowInsecureLocalhost: true } as const;

describe("AT-06 — no sanitized verdict, no network", () => {
  it("case A: no sanitized verdict → BLOCK, 0 requests", async () => {
    const { transport, calls } = recordingTransport();
    const r = raw();
    const res = await transmitVisualContext({
      permit: undefined,
      image: r, // raw capture, no verdict anywhere
      metadata: metadata(),
      task: TASK,
      transport,
      ...NET,
    });
    expect(res.verdict).toBe("BLOCK");
    expect(calls).toHaveLength(0);
    console.log(`[AT-06] A no-verdict → BLOCK (${res.code}), requests=0`);
    r.dispose();
  });

  it("case B: sanitized-but-unverified impossible → closest shapes BLOCK, 0 requests", async () => {
    const { transport, calls } = recordingTransport();
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    image.dispose(); // use-after-dispose: the only way a sealed artifact loses its verdict
    const dead = await transmitVisualContext({
      permit: { id: "permit_dead" },
      image,
      metadata: metadata(),
      task: TASK,
      transport,
      ...NET,
    });
    expect(dead.verdict).toBe("BLOCK");
    // Forged "verified" lookalike.
    const forged = await transmitVisualContext({
      permit: { id: "permit_forged" },
      image: { width: 64, height: 48, manifest: { version: "1", regions: [] }, verification: { ok: true } },
      metadata: metadata(),
      task: TASK,
      transport,
      ...NET,
    });
    expect(forged.verdict).toBe("BLOCK");
    expect(calls).toHaveLength(0);
    console.log(`[AT-06] B unverified-shapes → BLOCK (${dead.code}/${forged.code}), requests=0`);
    r.dispose();
  });

  it("case C: manifest invalid → BLOCK, 0 requests", async () => {
    const { transport, calls } = recordingTransport();
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const { permit } = await authorizeVisualTransmission({ image, metadata: metadata() });
    const badManifest = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0, 0, -4, 5] }] };
    const res = await transmitVisualContext({
      permit,
      image,
      manifest: badManifest,
      metadata: metadata(),
      task: TASK,
      transport,
      ...NET,
    });
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("MANIFEST_MISMATCH");
    expect(calls).toHaveLength(0);
    console.log(`[AT-06] C invalid-manifest → BLOCK (${res.code}), requests=0`);
    image.dispose();
    r.dispose();
  });

  it("case D: valid artifact + manifest + verification → ALLOW, 1 request", async () => {
    const { transport, calls } = recordingTransport();
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const meta = metadata();
    const { permit } = await authorizeVisualTransmission({ image, metadata: meta });
    expect(permit).toBeDefined();
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      ...NET,
    });
    expect(res.verdict).toBe("ALLOW");
    expect(res.transmitted).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].body);
    expect(body.redaction_manifest).toEqual(image.manifest);
    console.log(`[AT-06] D valid → ALLOW, requests=1, bytes=${calls[0].body.length}`);
    image.dispose();
    r.dispose();
  });
});
