import { describe, it, expect } from "vitest";
import { renderRedactions } from "@/privacy/redaction-render";
import { verifyRedaction } from "@/privacy/pixel-verify";
import { buildManifest } from "@/privacy/redaction-manifest";
import type { RedactionOperation } from "@/privacy/redaction-planner";

/* Phase 3 §20 + §33 — verification of actual pixels + manifest consistency. */

function scene(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

function op(partial: Partial<RedactionOperation>): RedactionOperation {
  return {
    id: "r1",
    type: "PASSWORD",
    method: "BLACKOUT",
    bbox: [10, 10, 20, 10],
    confidence: 0.96,
    severity: "high",
    mergedTypes: ["PASSWORD"],
    ...partial,
  };
}

const gradient = scene(64, 48, (x, y) => [(x * 4) % 256, (y * 5) % 256, ((x + y) * 3) % 256, 255]);

describe("pixel-verify.ts", () => {
  it("passes a correct BLACKOUT render with full check detail", () => {
    const ops = [op({})];
    const out = renderRedactions(gradient, ops);
    const v = verifyRedaction(gradient, out, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.checks.map((c) => c.name)).toContain("dimensions");
    expect(v.checks.map((c) => c.name)).toContain("blackout:r1");
    expect(v.checks.map((c) => c.name)).toContain("outside-untouched");
    expect(v.checks.map((c) => c.name)).toContain("manifest-consistent");
    expect(v.redactedPixels).toBe(200);
    expect(v.preservedPixels).toBe(64 * 48 - 200);
  });

  it("passes MASK and records divergence from the original", () => {
    const ops = [op({ id: "r1", type: "EMAIL", method: "MASK" })];
    const out = renderRedactions(gradient, ops);
    const v = verifyRedaction(gradient, out, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.name === "mask:r1" && c.ok)).toBe(true);
    expect(v.checks.some((c) => c.name === "mask-divergence:r1" && c.ok)).toBe(true);
  });

  it("passes BLUR on a textured region (variance drops, pixels change)", () => {
    const ops = [op({ id: "r1", type: "FACE", method: "BLUR", bbox: [8, 8, 32, 24] })];
    const out = renderRedactions(gradient, ops);
    const v = verifyRedaction(gradient, out, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.name === "blur:r1" && c.ok)).toBe(true);
  });

  it("passes BLUR on a uniform region with a recorded note (nothing reconstructible)", () => {
    const flat = scene(32, 32, () => [200, 200, 200, 255]);
    const ops = [op({ id: "r1", type: "FACE", method: "BLUR", bbox: [4, 4, 16, 16] })];
    const out = renderRedactions(flat, ops);
    const v = verifyRedaction(flat, out, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(true);
  });

  it("fails when the output was never redacted (skipped region)", () => {
    const ops = [op({})];
    // Verify raw-vs-raw: nothing was painted.
    const v = verifyRedaction(gradient, gradient, ops.map((o) => ({ ...o, appliedBbox: o.bbox })), buildManifest(ops));
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.includes("blackout:r1"))).toBe(true);
  });

  it("fails when pixels outside the boxes were touched", () => {
    const ops = [op({})];
    const out = renderRedactions(gradient, ops);
    out.data[0] = (out.data[0] + 1) % 256; // tamper outside
    const v = verifyRedaction(gradient, out, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.includes("outside-untouched"))).toBe(true);
  });

  it("fails on dimension mismatch", () => {
    const ops = [op({})];
    const out = renderRedactions(gradient, ops);
    const small = { width: 32, height: 24, data: new Uint8ClampedArray(32 * 24 * 4) };
    const v = verifyRedaction(gradient, small, out.applied, buildManifest(out.applied));
    expect(v.ok).toBe(false);
  });

  it("fails when the manifest does not match the applied ops", () => {
    const ops = [op({})];
    const out = renderRedactions(gradient, ops);
    const manifest = buildManifest(out.applied);
    manifest.regions[0].method = "BLUR"; // tampered declaration
    const v = verifyRedaction(gradient, out, out.applied, manifest);
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.includes("manifest-consistent"))).toBe(true);
  });

  it("empty ops + empty manifest verify clean (nothing sensitive path)", () => {
    const v = verifyRedaction(gradient, gradient, [], buildManifest([]));
    expect(v.ok).toBe(true);
    expect(v.preservedPixels).toBe(64 * 48);
  });
});
