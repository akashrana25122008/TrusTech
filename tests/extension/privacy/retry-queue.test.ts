import { describe, it, expect } from "vitest";
import {
  VisualTransmissionQueue,
  drainTelemetry,
  transmitVisualContext,
  transmitWithRetry,
  type VisualTransport,
} from "@/privacy/visual-transmission";
import { authorizeVisualTransmission, PERMIT_TTL_MS } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 4 §19 + §20 + §33 — retry reuses sealed bytes; queue holds permits only. */

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

function raw() {
  const data = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
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

const TASK = { goal: "pay the bill" };
const NET = { baseUrl: "http://localhost:8000", allowInsecureLocalhost: true } as const;

async function authorized() {
  const r = raw();
  const { image } = sanitizeImage(r, [region()]);
  const meta = metadata();
  const { permit } = await authorizeVisualTransmission({ image, metadata: meta });
  return { r, image, meta, permit: permit! };
}

function mockTransport(script: Array<{ ok: boolean; status: number }>): {
  transport: VisualTransport;
  bodies: string[];
} {
  const bodies: string[] = [];
  let n = 0;
  return {
    bodies,
    transport: {
      async post(_url: string, body: string) {
        bodies.push(body);
        const step = script[Math.min(n++, script.length - 1)];
        return { ok: step.ok, status: step.status };
      },
    },
  };
}

describe("retry + queue", () => {
  it("retry reuses the identical sanitized bytes (never regenerates pixels)", async () => {
    drainTelemetry();
    const { r, image, meta, permit } = await authorized();
    const { transport, bodies } = mockTransport([
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ]);
    const res = await transmitWithRetry(
      { permit, image, metadata: meta, task: TASK, transport, ...NET },
      { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    );
    expect(res.verdict).toBe("ALLOW");
    expect(res.attempts).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]); // byte-identical retry
    const events = drainTelemetry().map((e) => e.type);
    expect(events).toContain("UPSTREAM_REJECTED");
    expect(events).toContain("TRANSMISSION_ALLOWED");
    image.dispose();
    r.dispose();
  });

  it("retry stops at privacy verdicts (no re-authorize loop)", async () => {
    const { r, image, meta, permit } = await authorized();
    image.dispose(); // kill the artifact → revalidation fails
    const { transport, bodies } = mockTransport([{ ok: true, status: 200 }]);
    let attempts = 0;
    const res = await transmitWithRetry(
      { permit, image, metadata: meta, task: TASK, transport, ...NET },
      { maxAttempts: 3, onAttempt: () => attempts++ },
    );
    expect(res.verdict).toBe("BLOCK");
    expect(attempts).toBe(1);
    expect(bodies).toHaveLength(0);
    r.dispose();
  });

it("expired permit stops transmission and retries (revalidation each attempt)", async () => {
    const { r, image, meta, permit } = await authorized();
    const { transport, bodies } = mockTransport([{ ok: true, status: 200 }]);
    const future = Date.now() + PERMIT_TTL_MS + 1000;
    const res = await transmitWithRetry(
      { permit, image, metadata: meta, task: TASK, transport, ...NET, now: future },
      { maxAttempts: 3 },
    );
    expect(res.verdict).toBe("BLOCK");
    expect(bodies).toHaveLength(0);
    image.dispose();
    r.dispose();
  });

  it("queue rejects raw captures, forged items, and permit-less items", () => {
    const q = new VisualTransmissionQueue(2);
    const r = raw();
    expect(q.enqueue({ image: r, permit: { id: "x" }, manifest: {}, metadata: {}, task: TASK }).accepted).toBe(false);
    expect(q.enqueue({ image: { width: 1 }, permit: undefined, manifest: {}, metadata: {}, task: TASK }).accepted).toBe(false);
    expect(q.size).toBe(0);
    r.dispose();
  });

  it("queue accepts sealed items and drains sanitized-only (offline-safe shape)", async () => {
    const a = await authorized();
    const b = await authorized();
    const q = new VisualTransmissionQueue(2);
    expect(q.enqueue({ permit: a.permit, image: a.image, manifest: a.image.manifest, metadata: a.meta, task: TASK }).accepted).toBe(true);
    expect(q.enqueue({ permit: b.permit, image: b.image, manifest: b.image.manifest, metadata: b.meta, task: TASK }).accepted).toBe(true);
    expect(q.enqueue({ permit: b.permit, image: b.image, manifest: b.image.manifest, metadata: b.meta, task: TASK }).accepted).toBe(false); // full
    const { transport, bodies } = mockTransport([{ ok: true, status: 200 }]);
    const results = await q.drain((item) =>
      transmitVisualContext({ permit: item.permit, image: item.image, metadata: item.metadata, task: item.task, transport, ...NET }),
    );
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.result.verdict === "ALLOW")).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(q.size).toBe(0);
    a.image.dispose();
    b.image.dispose();
    a.r.dispose();
    b.r.dispose();
  });

  it("queue item that died in-queue reports BLOCK at drain (no raw fallback)", async () => {
    const a = await authorized();
    const q = new VisualTransmissionQueue();
    q.enqueue({ permit: a.permit, image: a.image, manifest: a.image.manifest, metadata: a.meta, task: TASK });
    a.image.dispose(); // dies while queued (offline hold → eviction path)
    const { transport, bodies } = mockTransport([{ ok: true, status: 200 }]);
    const results = await q.drain((item) =>
      transmitVisualContext({ permit: item.permit, image: item.image, metadata: item.metadata, task: item.task, transport, ...NET }),
    );
    expect(results[0].result.verdict).toBe("BLOCK");
    expect(bodies).toHaveLength(0);
    a.r.dispose();
  });
});
