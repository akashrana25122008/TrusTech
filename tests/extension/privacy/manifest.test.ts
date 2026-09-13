import { describe, it, expect } from "vitest";
import {
  REDACTION_MANIFEST_VERSION,
  buildManifest,
  manifestsEqual,
  validateRedactionManifest,
} from "@/privacy/redaction-manifest";
import { planRedactions } from "@/privacy/redaction-planner";
import type { SensitiveRegion } from "@/privacy/regions";

/* Phase 3 §13 + §14 + §32 — manifest built from applied ops; strict validation. */

function region(partial: Partial<SensitiveRegion>): SensitiveRegion {
  return {
    type: "AADHAAR",
    bbox: { x: 100, y: 100, width: 200, height: 40 },
    confidence: 0.95,
    severity: "high",
    source: "text",
    sources: ["text"],
    evidence: [],
    image: { width: 640, height: 480 },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
    ...partial,
  } as SensitiveRegion;
}

describe("redaction-manifest.ts", () => {
  it("builds the canonical manifest shape from applied operations", () => {
    const { operations } = planRedactions([region({})], { width: 640, height: 480 });
    const manifest = buildManifest(operations);
    expect(manifest).toEqual({
      version: "1",
      regions: [{ id: "r1", type: "AADHAAR", method: "BLACKOUT", bbox: [92, 92, 216, 56] }],
    });
    expect(REDACTION_MANIFEST_VERSION).toBe("1");
  });

  it("empty operations yield an empty (valid) manifest", () => {
    const manifest = buildManifest([]);
    expect(manifest).toEqual({ version: "1", regions: [] });
    expect(validateRedactionManifest(manifest).ok).toBe(true);
  });

  it("validates a well-formed manifest against image bounds", () => {
    const { operations } = planRedactions([region({})], { width: 640, height: 480 });
    const v = validateRedactionManifest(buildManifest(operations), { width: 640, height: 480 });
    expect(v).toEqual({ ok: true, errors: [] });
  });

  it("rejects wrong versions", () => {
    expect(validateRedactionManifest({ version: "2", regions: [] }).ok).toBe(false);
    expect(validateRedactionManifest({ regions: [] }).ok).toBe(false);
    expect(validateRedactionManifest(null).ok).toBe(false);
    expect(validateRedactionManifest("r1").ok).toBe(false);
  });

  it("rejects bad ids, unknown types, unsupported methods", () => {
    const bad = {
      version: "1",
      regions: [
        { id: "x", type: "AADHAAR", method: "BLACKOUT", bbox: [0, 0, 10, 10] },
        { id: "r1", type: "NOPE", method: "BLACKOUT", bbox: [0, 0, 10, 10] },
        { id: "r2", type: "PAN", method: "ERASE", bbox: [0, 0, 10, 10] },
      ],
    };
    const v = validateRedactionManifest(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects duplicate ids and malformed bboxes", () => {
    const dup = {
      version: "1",
      regions: [
        { id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0, 0, 10, 10] },
        { id: "r1", type: "PAN", method: "BLACKOUT", bbox: [20, 20, 10, 10] },
      ],
    };
    expect(validateRedactionManifest(dup).ok).toBe(false);
    const badBox = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0, 0, -5, 10] }] };
    expect(validateRedactionManifest(badBox).ok).toBe(false);
    const floatBox = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0.5, 0, 10, 10] }] };
    expect(validateRedactionManifest(floatBox).ok).toBe(false);
    const zeroBox = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [0, 0, 0, 10] }] };
    expect(validateRedactionManifest(zeroBox).ok).toBe(false);
  });

  it("rejects boxes outside the image when bounds are supplied", () => {
    const m = { version: "1", regions: [{ id: "r1", type: "PAN", method: "BLACKOUT", bbox: [630, 470, 50, 50] }] };
    expect(validateRedactionManifest(m, { width: 640, height: 480 }).ok).toBe(false);
    expect(validateRedactionManifest(m).ok).toBe(true); // no bounds → shape-only check
  });

  it("rejects oversized region counts", () => {
    const regions = Array.from({ length: 10 }, (_, i) => ({ id: `r${i + 1}`, type: "PAN", method: "BLACKOUT", bbox: [i, 0, 1, 1] }));
    expect(validateRedactionManifest({ version: "1", regions }, undefined, { maxRegions: 5 }).ok).toBe(false);
  });

  it("manifestsEqual detects substitution", () => {
    const { operations } = planRedactions([region({})], { width: 640, height: 480 });
    const a = buildManifest(operations);
    const b = buildManifest(operations);
    expect(manifestsEqual(a, b)).toBe(true);
    const tampered = buildManifest(operations);
    tampered.regions[0].method = "BLUR";
    expect(manifestsEqual(a, tampered)).toBe(false);
    const dropped = { version: "1" as const, regions: [] };
    expect(manifestsEqual(a, dropped)).toBe(false);
  });
});
