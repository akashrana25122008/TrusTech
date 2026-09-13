import { describe, it, expect, vi } from "vitest";
import {
  assertSecureEndpoint,
  buildVisualPayload,
  drainTelemetry,
  fetchTransport,
  transmitVisualContext,
  validateTaskPayload,
  validateVisualPayload,
  type VisualTransport,
} from "@/privacy/visual-transmission";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 4 §4 + §5 + §16 + §17 + §21 + §25 — sender contract tests. */

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

const TASK = { goal: "pay the bill", intent: "payment" };

function mockTransport(status = 200): { transport: VisualTransport; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const transport: VisualTransport = {
    async post(url, body) {
      calls.push({ url, body });
      return { ok: status >= 200 && status < 300, status };
    },
  };
  return { transport, calls };
}

async function authorized() {
  const r = raw();
  const { image } = sanitizeImage(r, [region()]);
  const meta = metadata();
  const { permit } = await authorizeVisualTransmission({ image, metadata: meta });
  return { r, image, meta, permit: permit! };
}

describe("visual-transmission.ts", () => {
  /* ---- payload schema (§4) ---- */
  it("builds the exact §4 payload shape", async () => {
    const { r, image, meta } = await authorized();
    const payload = buildVisualPayload(TASK, image, image.manifest, meta);
    expect(Object.keys(payload).sort()).toEqual(["redaction_manifest", "task", "vision_metadata", "visual_context"]);
    expect(Object.keys(payload.visual_context).sort()).toEqual(["height", "image", "width"]);
    expect(payload.visual_context.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(payload.visual_context.width).toBe(64);
    expect(payload.visual_context.height).toBe(48);
    expect(validateVisualPayload(payload).ok).toBe(true);
    image.dispose();
    r.dispose();
  });

  it("validateVisualPayload rejects smuggled keys and bad shapes", () => {
    expect(validateVisualPayload(null).ok).toBe(false);
    expect(validateVisualPayload({ task: TASK }).ok).toBe(false);
    const bad = { task: TASK, visual_context: { image: "http://x/y.jpg", width: 64, height: 48 }, redaction_manifest: { version: "1", regions: [] }, vision_metadata: metadata(), evil: 1 };
    const v = validateVisualPayload(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
    expect(validateTaskPayload({ goal: "" }).length).toBeGreaterThan(0);
    expect(validateTaskPayload({ goal: "ok", screenshot: "x" }).length).toBeGreaterThan(0);
  });

  /* ---- HTTPS (§17) ---- */
  it("assertSecureEndpoint: https always ok; http rejected unless loopback dev", () => {
    expect(assertSecureEndpoint("https://api.example.com/api/agent/vision", false)).toBeNull();
    expect(assertSecureEndpoint("http://api.example.com/api/agent/vision", false)).toContain("https required");
    expect(assertSecureEndpoint("http://localhost:8000/api/agent/vision", true)).toBeNull();
    expect(assertSecureEndpoint("http://127.0.0.1:8000/x", true)).toBeNull();
    expect(assertSecureEndpoint("http://evil.example.com/x", true)).toContain("loopback");
    expect(assertSecureEndpoint("not a url", true)).toContain("valid URL");
  });

  it("BLOCKS insecure production endpoint with zero requests", async () => {
    const { r, image, meta, permit } = await authorized();
    const { transport, calls } = mockTransport();
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://api.example.com",
    });
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("INSECURE_TRANSPORT");
    expect(calls).toHaveLength(0);
    image.dispose();
    r.dispose();
  });

  /* ---- happy path ---- */
  it("ALLOWs with one request carrying the exact payload", async () => {
    const { r, image, meta, permit } = await authorized();
    const { transport, calls } = mockTransport();
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });
    expect(res.verdict).toBe("ALLOW");
    expect(res.transmitted).toBe(true);
    expect(res.requestCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8000/api/agent/vision");
    const body = JSON.parse(calls[0].body);
    expect(validateVisualPayload(body).ok).toBe(true);
    expect(body.redaction_manifest).toEqual(image.manifest);
    expect(body.vision_metadata).toEqual(meta);
    expect(body.task.goal).toBe("pay the bill");
    expect(res.latenciesMs.totalMs).toBeGreaterThanOrEqual(0);
    image.dispose();
    r.dispose();
  });

  /* ---- no permit → no network (§11) ---- */
  it("BLOCKS without a permit and never touches the transport", async () => {
    const { r, image, meta } = await authorized();
    const { transport, calls } = mockTransport();
    for (const permit of [undefined, null, { id: "fake" }]) {
      const res = await transmitVisualContext({
        permit,
        image,
        metadata: meta,
        task: TASK,
        transport,
        baseUrl: "http://localhost:8000",
        allowInsecureLocalhost: true,
      });
      expect(res.verdict).toBe("BLOCK");
      expect(res.code).toBe("NO_PERMIT");
    }
    expect(calls).toHaveLength(0);
    image.dispose();
    r.dispose();
  });

  it("BLOCKS raw image inputs (§3: type boundary)", async () => {
    const { transport, calls } = mockTransport();
    const { r, image, meta, permit } = await authorized();
    for (const bad of [r, new Uint8Array(8), "data:image/png;base64,AAAA", new Blob(["x"]), null]) {
      const res = await transmitVisualContext({
        permit,
        image: bad,
        metadata: meta,
        task: TASK,
        transport,
        baseUrl: "http://localhost:8000",
        allowInsecureLocalhost: true,
      });
      expect(res.verdict).toBe("BLOCK");
      expect(res.code).toBe("NOT_SANITIZED_ARTIFACT");
    }
    expect(calls).toHaveLength(0);
    void image;
    r.dispose();
  });

  /* ---- upstream / timeout / abort (§21) ---- */
  it("BLOCKS on upstream rejection without retrying raw", async () => {
    const { r, image, meta, permit } = await authorized();
    const { transport, calls } = mockTransport(422);
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("UPSTREAM_REJECTED");
    expect(calls).toHaveLength(1);
    image.dispose();
    r.dispose();
  });

  it("BLOCKS on timeout with zero completed requests", async () => {
    const { r, image, meta, permit } = await authorized();
    const hanging: VisualTransport = {
      post: (_url, _body, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport: hanging,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
      timeoutMs: 30,
    });
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("TIMEOUT");
    image.dispose();
    r.dispose();
  });

  it("BLOCKS on user abort before start", async () => {
    const { r, image, meta, permit } = await authorized();
    const { transport, calls } = mockTransport();
    const controller = new AbortController();
    controller.abort();
    const res = await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
      signal: controller.signal,
    });
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("ABORTED");
    expect(calls).toHaveLength(0);
    image.dispose();
    r.dispose();
  });

  /* ---- telemetry (§25/26) ---- */
  it("emits value-free telemetry for ALLOW and BLOCK", async () => {
    drainTelemetry();
    const { r, image, meta, permit } = await authorized();
    const { transport } = mockTransport();
    await transmitVisualContext({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });
    await transmitVisualContext({
      permit: undefined,
      image,
      metadata: meta,
      task: TASK,
      transport,
      baseUrl: "http://localhost:8000",
      allowInsecureLocalhost: true,
    });
    const events = drainTelemetry();
    expect(events.map((e) => e.type)).toEqual(["TRANSMISSION_ALLOWED", "TRANSMISSION_BLOCKED"]);
    expect(JSON.stringify(events)).not.toContain("data:image");
    image.dispose();
    r.dispose();
  });

  it("fetchTransport adapts a fetch fn into the transport interface", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response("{}", { status: 200 }));
    const transport = fetchTransport(fetchFn as typeof fetch);
    const res = await transport.post("https://api.example.com/x", "{}", { headers: { "Content-Type": "application/json" } });
    expect(res).toEqual({ ok: true, status: 200, body: "{}" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/x");
    expect(init.method).toBe("POST");
  });
});
