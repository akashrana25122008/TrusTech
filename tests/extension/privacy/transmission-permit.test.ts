import { describe, it, expect } from "vitest";
import {
  PERMIT_TTL_MS,
  authorizeVisualTransmission,
  isLivePermit,
  revalidatePermit,
} from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 4 §9 + §29 + §30 — permit issue, binding, expiry, revalidation. */

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

describe("transmission-permit.ts", () => {
  it("issues a sealed, expiring permit for a verified artifact", async () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const res = await authorizeVisualTransmission({ image, metadata: metadata() });
    expect(res.ok).toBe(true);
    expect(res.permit).toBeDefined();
    expect(res.permit!.id.startsWith("permit_")).toBe(true);
    expect(res.permit!.regionCount).toBe(1);
    expect(res.permit!.manifestVersion).toBe("1");
    expect(res.permit!.expiresAt - res.permit!.issuedAt).toBe(PERMIT_TTL_MS);
    expect(res.permit!.imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.permit!.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(res.permit)).toBe(true);
    expect(isLivePermit(res.permit)).toBe(true);
    image.dispose();
    r.dispose();
  });

  it("same bytes + manifest always hash identically (deterministic binding)", async () => {
    const mk = () => {
      const r = raw();
      const { image } = sanitizeImage(r, [region()]);
      return { r, image };
    };
    const a = mk();
    const b = mk();
    const pa = await authorizeVisualTransmission({ image: a.image, metadata: metadata() });
    const pb = await authorizeVisualTransmission({ image: b.image, metadata: metadata() });
    expect(pa.permit!.imageHash).toBe(pb.permit!.imageHash);
    expect(pa.permit!.manifestHash).toBe(pb.permit!.manifestHash);
    a.image.dispose();
    b.image.dispose();
    a.r.dispose();
    b.r.dispose();
  });

  it("refuses raw captures, forged objects, disposed and unverified artifacts", async () => {
    const r = raw();
    const rawRes = await authorizeVisualTransmission({ image: r, metadata: metadata() });
    expect(rawRes.ok).toBe(false);
    expect(rawRes.code).toBe("NOT_SANITIZED_ARTIFACT");

    const forged = { width: 64, height: 48, manifest: { version: "1", regions: [] }, verification: { ok: true } };
    expect((await authorizeVisualTransmission({ image: forged, metadata: metadata() })).ok).toBe(false);

    const { image } = sanitizeImage(r, [region()]);
    image.dispose();
    const disp = await authorizeVisualTransmission({ image, metadata: metadata() });
    expect(disp.ok).toBe(false);
    expect(disp.code).toBe("DISPOSED_ARTIFACT");
    r.dispose();
  });

  it("refuses substituted manifests and missing/invalid metadata", async () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const swapped = { version: "1", regions: [{ id: "r1", type: "EMAIL", method: "MASK", bbox: [0, 0, 8, 8] }] };
    const sub = await authorizeVisualTransmission({ image, manifest: swapped, metadata: metadata() });
    expect(sub.ok).toBe(false);
    expect(sub.code).toBe("MANIFEST_MISMATCH");

    const noMeta = await authorizeVisualTransmission({ image });
    expect(noMeta.ok).toBe(false);
    expect(noMeta.code).toBe("INVALID_METADATA");

    const badMeta = await authorizeVisualTransmission({ image, metadata: { model: "nope" } });
    expect(badMeta.ok).toBe(false);

    const optOut = await authorizeVisualTransmission({ image, requireMetadata: false });
    expect(optOut.ok).toBe(true);
    image.dispose();
    r.dispose();
  });

  it("revalidatePermit passes live bindings and fails expired permits", async () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const { permit } = await authorizeVisualTransmission({ image, metadata: metadata() });
    expect((await revalidatePermit({ permit, image })).ok).toBe(true);
    // Expired: travel past TTL.
    const expired = await revalidatePermit({ permit, image, now: Date.now() + PERMIT_TTL_MS + 1000 });
    expect(expired.ok).toBe(false);
    expect(isLivePermit(permit)).toBe(true); // still live right now
    image.dispose();
    r.dispose();
  });

  it("revalidatePermit fails unknown permits", async () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region()]);
    const fake = { id: "permit_x", imageHash: "0".repeat(64), manifestHash: "0".repeat(64) };
    expect((await revalidatePermit({ permit: fake, image })).ok).toBe(false);
    image.dispose();
    r.dispose();
  });
});
