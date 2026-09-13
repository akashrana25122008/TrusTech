import { describe, it, expect, vi } from "vitest";
import { ImageTransmissionGate, buildImagePayload } from "@/privacy/image-gate";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 3 §16 + §23 + §28 — the gate blocks everything but sealed artifacts. */

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

function sealed() {
  const r = raw();
  const { image } = sanitizeImage(r, [region()]);
  r.dispose();
  return image;
}

function gateWithSpy() {
  const fetchFn = vi.fn(
    async (_url: string, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ received: true }), { status: 200 }),
  );
  return { gate: new ImageTransmissionGate({ baseUrl: "http://localhost:8000", fetchFn: fetchFn as typeof fetch }), fetchFn };
}

describe("image-gate.ts", () => {
  /* ---- §28 bypass vectors 1–8: raw shapes never reach the network ---- */
  it.each([
    ["raw ImageBitmap-like", { fake: "bitmap" }],
    ["raw Blob", new Blob(["pixels"])],
    ["raw ArrayBuffer", new ArrayBuffer(16)],
    ["raw Uint8Array", new Uint8Array(16)],
    ["raw base64", "aGVsbG8gd29ybGQ=".repeat(30)],
    ["raw data-url", "data:image/png;base64," + "AAAA".repeat(100)],
    ["raw FormData-shaped", { body: new Blob(["x"]), headers: {} }],
    ["raw message-shaped", { type: "CTX_SEND", payload: { screenshot: "data:image/png;base64,AAAA" } }],
  ])("BLOCKS %s without any fetch", async (_label, payload) => {
    const { gate, fetchFn } = gateWithSpy();
    const res = await gate.sendSanitized(payload);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("NOT_SANITIZED_ARTIFACT");
    expect(res.transmitted).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("BLOCKS null/undefined/strings", async () => {
    const { gate, fetchFn } = gateWithSpy();
    for (const v of [null, undefined, 42, "nope"]) {
      const res = await gate.sendSanitized(v);
      expect(res.verdict).toBe("BLOCK");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /* ---- vectors 9–12: malformed / missing / mismatched / unverified ---- */
  it("BLOCKS 9: forged SanitizedImage lookalike (never sealed)", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const fake = { width: 64, height: 48, manifest: { version: "1", regions: [] }, verification: { ok: true } };
    const res = await gate.sendSanitized(fake);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("NOT_SANITIZED_ARTIFACT");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("vector 10: nullish presented manifest falls back to the sealed one (ALLOW); non-object manifest BLOCKS", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const image = sealed();
    const fallback = await gate.sendSanitized(image, null);
    expect(fallback.verdict).toBe("ALLOW"); // sealed manifest is the trusted source
    const bad = await gate.sendSanitized(image, "nope");
    expect(bad.verdict).toBe("BLOCK");
    expect(bad.code).toBe("INVALID_MANIFEST");
    image.dispose();
    expect(fetchFn).toHaveBeenCalledTimes(1); // only the fallback ALLOW touched the network
  });

  it("BLOCKS invalid presented manifest (bad version / bad box)", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const image = sealed();
    const badVersion = { version: "99", regions: [] };
    const r1 = await gate.sendSanitized(image, badVersion);
    expect(r1.verdict).toBe("BLOCK");
    expect(r1.code).toBe("INVALID_MANIFEST");
    const badBox = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0, 0, -3, 5] }] };
    const r2 = await gate.sendSanitized(image, badBox);
    expect(r2.verdict).toBe("BLOCK");
    expect(r2.code).toBe("INVALID_MANIFEST");
    expect(fetchFn).not.toHaveBeenCalled();
    image.dispose();
  });

  it("BLOCKS 11: mismatched (substituted) manifest", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const image = sealed();
    const swapped = {
      version: "1",
      regions: [{ id: "r1", type: "EMAIL", method: "MASK", bbox: [4, 4, 8, 8] }],
    };
    const res = await gate.sendSanitized(image, swapped);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("MANIFEST_MISMATCH");
    expect(fetchFn).not.toHaveBeenCalled();
    image.dispose();
  });

  it("BLOCKS disposed artifacts", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const image = sealed();
    image.dispose();
    const res = await gate.sendSanitized(image);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("DISPOSED_ARTIFACT");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /* ---- happy path + upstream discipline ---- */
  it("ALLOWs a sealed artifact and POSTs sanitized PNG + manifest", async () => {
    const { gate, fetchFn } = gateWithSpy();
    const image = sealed();
    const res = await gate.sendSanitized(image);
    expect(res.verdict).toBe("ALLOW");
    expect(res.transmitted).toBe(true);
    expect(res.regionCount).toBe(1);
    expect(res.manifestVersion).toBe("1");
    expect(res.bytesSent).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/api/agent/vision");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(body.manifest.version).toBe("1");
    expect(body.manifest.regions).toHaveLength(1);
    image.dispose();
  });

  it("BLOCKS on upstream rejection (no retry with raw — there is no raw path)", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 422 }));
    const gate = new ImageTransmissionGate({ fetchFn: fetchFn as typeof fetch });
    const image = sealed();
    const res = await gate.sendSanitized(image);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("UPSTREAM_REJECTED");
    expect(res.transmitted).toBe(false);
    image.dispose();
  });

  it("BLOCKS on transport errors without throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const gate = new ImageTransmissionGate({ fetchFn: fetchFn as typeof fetch });
    const image = sealed();
    const res = await gate.sendSanitized(image);
    expect(res.verdict).toBe("BLOCK");
    expect(res.code).toBe("TRANSPORT_ERROR");
    image.dispose();
  });

  it("buildImagePayload exposes the exact wire format", () => {
    const image = sealed();
    const payload = buildImagePayload(image);
    expect(payload.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(payload.manifest).toEqual(image.manifest);
    image.dispose();
  });
});
