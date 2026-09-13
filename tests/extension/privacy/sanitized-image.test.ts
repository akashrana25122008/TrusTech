import { describe, it, expect } from "vitest";
import {
  RawCapture,
  SanitizedImage,
  SanitizeError,
  isSealedSanitizedImage,
  sanitizeImage,
} from "@/privacy/sanitized-image";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 3 §15 + §23 + §24 — distinct trusted artifact, fail-closed, disposal. */

function region(partial: Partial<SensitiveRegion>): SensitiveRegion {
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
    ...partial,
  } as SensitiveRegion;
}

function raw(w = 64, h = 48) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  return RawCapture.from(w, h, data);
}

describe("sanitized-image.ts", () => {
  it("sanitizeImage seals a verified artifact with manifest + verification", () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region({})]);
    expect(image).toBeInstanceOf(SanitizedImage);
    expect(isSealedSanitizedImage(image)).toBe(true);
    expect(image.manifest.version).toBe("1");
    expect(image.manifest.regions).toHaveLength(1);
    expect(image.manifest.regions[0].method).toBe("BLACKOUT");
    expect(image.verification.ok).toBe(true);
    expect(image.width).toBe(64);
    expect(image.height).toBe(48);
    image.dispose();
  });

  it("does not mutate the raw capture", () => {
    const r = raw();
    const before = new Uint8ClampedArray(r.data);
    const { image } = sanitizeImage(r, [region({})]);
    expect(r.data).toEqual(before);
    image.dispose();
    r.dispose();
  });

  it("empty regions yield a verified-clean artifact (nothing to hide)", () => {
    const r = raw();
    const { image } = sanitizeImage(r, []);
    expect(isSealedSanitizedImage(image)).toBe(true);
    expect(image.manifest.regions).toEqual([]);
    expect(image.verification.ok).toBe(true);
    image.dispose();
    r.dispose();
  });

  it("pngBytes are deterministic across runs", () => {
    const a = raw();
    const b = raw();
    const { image: ia } = sanitizeImage(a, [region({})]);
    const { image: ib } = sanitizeImage(b, [region({})]);
    expect(ia.pngBytes()).toEqual(ib.pngBytes());
    expect(ia.pngBytes().slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    ia.dispose();
    ib.dispose();
    a.dispose();
    b.dispose();
  });

  it("rejects disposed or malformed raw input (fail closed)", () => {
    const r = raw();
    r.dispose();
    expect(() => sanitizeImage(r, [region({})])).toThrow(SanitizeError);
    expect(() => RawCapture.from(0, 10, new Uint8ClampedArray(0))).toThrow(SanitizeError);
    expect(() => RawCapture.from(4, 4, new Uint8ClampedArray(3))).toThrow(SanitizeError);
  });

  it("dispose() zero-fills and unseals (gate refuses afterwards)", () => {
    const r = raw();
    const { image } = sanitizeImage(r, [region({})]);
    expect(isSealedSanitizedImage(image)).toBe(true);
    image.dispose();
    expect(image.disposed).toBe(true);
    expect(isSealedSanitizedImage(image)).toBe(false);
    expect(() => image.pngBytes()).toThrow(SanitizeError);
    r.dispose();
  });

  it("a forged lookalike object is not a sealed artifact", () => {
    const fake = {
      width: 64,
      height: 48,
      manifest: { version: "1", regions: [] },
      verification: { ok: true },
    };
    expect(isSealedSanitizedImage(fake)).toBe(false);
    expect(isSealedSanitizedImage(null)).toBe(false);
    expect(isSealedSanitizedImage("data:image/png;base64,AAAA")).toBe(false);
  });

  it("RawCapture.dispose zero-fills the buffer", () => {
    const r = raw();
    expect(r.data.some((v) => v !== 0)).toBe(true);
    r.dispose();
    expect(r.disposed).toBe(true);
    expect(r.data.every((v) => v === 0)).toBe(true);
  });
});
