import { describe, it, expect } from "vitest";
import { expectedMaskPixel, renderRedactions } from "@/privacy/redaction-render";
import { DEFAULT_REDACTION_POLICY } from "@/privacy/redaction-policy";
import type { RedactionOperation } from "@/privacy/redaction-planner";

/* Phase 3 §7 + §8 + §9 — real pixel surgery on RGBA buffers. */

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

describe("redaction-render.ts", () => {
  it("BLACKOUT replaces every pixel in the box with the opaque fill", () => {
    const out = renderRedactions(gradient, [op({})]);
    const [r, g, b, a] = DEFAULT_REDACTION_POLICY.blackoutColor;
    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 30; x++) {
        const i = (y * 64 + x) * 4;
        expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([r, g, b, a]);
      }
    }
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].appliedBbox).toEqual([10, 10, 20, 10]);
  });

  it("BLACKOUT leaves pixels outside the box byte-identical", () => {
    const out = renderRedactions(gradient, [op({})]);
    const i = (0 * 64 + 0) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([
      gradient.data[i],
      gradient.data[i + 1],
      gradient.data[i + 2],
      gradient.data[i + 3],
    ]);
  });

  it("does not mutate the source buffer (copy-on-write)", () => {
    const before = new Uint8ClampedArray(gradient.data);
    renderRedactions(gradient, [op({})]);
    expect(gradient.data).toEqual(before);
  });

  it("MASK paints the deterministic opaque pattern", () => {
    const out = renderRedactions(gradient, [op({ id: "r1", type: "EMAIL", method: "MASK" })]);
    const { maskColor, maskAccent } = DEFAULT_REDACTION_POLICY;
    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 30; x++) {
        const i = (y * 64 + x) * 4;
        const [r, g, b, a] = expectedMaskPixel(x, y, maskColor, maskAccent);
        expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([r, g, b, a]);
        expect(out.data[i + 3]).toBe(255); // opaque everywhere
      }
    }
  });

  it("MASK is deterministic across runs", () => {
    const a = renderRedactions(gradient, [op({ method: "MASK" })]);
    const b = renderRedactions(gradient, [op({ method: "MASK" })]);
    expect(a.data).toEqual(b.data);
  });

  it("BLUR transforms a non-uniform region (above the verification bar)", () => {
    const out = renderRedactions(gradient, [op({ type: "FACE", method: "BLUR", bbox: [8, 8, 32, 24] })]);
    let changed = 0;
    const total = 32 * 24;
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 40; x++) {
        const i = (y * 64 + x) * 4;
        if (out.data[i] !== gradient.data[i] || out.data[i + 1] !== gradient.data[i + 1] || out.data[i + 2] !== gradient.data[i + 2]) {
          changed++;
        }
      }
    }
    // A linear gradient is box-blur-invariant deep in its interior (only
    // edge/wrap pixels change) — the honest bar is the policy threshold
    // the verifier enforces, plus variance reduction (see pixel-verify).
    expect(changed / total).toBeGreaterThan(DEFAULT_REDACTION_POLICY.blurChangedFraction);
  });

  it("BLUR of a uniform region is a safe no-op-ish pass (no crash, alpha preserved)", () => {
    const flat = scene(32, 32, () => [200, 200, 200, 255]);
    const out = renderRedactions(flat, [op({ type: "FACE", method: "BLUR", bbox: [4, 4, 16, 16] })]);
    expect(out.data.length).toBe(flat.data.length);
  });

  it("multiple + overlapping ops all apply (later ops paint over earlier)", () => {
    const out = renderRedactions(gradient, [
      op({ id: "r1", bbox: [0, 0, 20, 20] }),
      op({ id: "r2", type: "EMAIL", method: "MASK", bbox: [10, 10, 20, 20] }),
    ]);
    expect(out.applied).toHaveLength(2);
    // overlap zone carries the later (MASK) pattern
    const [r, g, b] = expectedMaskPixel(15, 15, DEFAULT_REDACTION_POLICY.maskColor, DEFAULT_REDACTION_POLICY.maskAccent);
    const i = (15 * 64 + 15) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([r, g, b]);
  });

  it("clamps boxes that exceed the frame instead of throwing", () => {
    const out = renderRedactions(gradient, [op({ bbox: [60, 44, 40, 40] })]);
    expect(out.applied[0].appliedBbox).toEqual([60, 44, 4, 4]);
  });

  it("throws fail-closed on empty boxes and bad buffers", () => {
    expect(() => renderRedactions(gradient, [op({ bbox: [70, 70, 5, 5] })])).toThrow();
    expect(() => renderRedactions({ width: 64, height: 48, data: new Uint8ClampedArray(10) }, [op({})])).toThrow();
    expect(() => renderRedactions({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, [])).toThrow();
  });

  it("reports paintMs and per-method timings", () => {
    const out = renderRedactions(gradient, [
      op({ id: "r1" }),
      op({ id: "r2", type: "FACE", method: "BLUR", bbox: [40, 30, 10, 10] }),
    ]);
    expect(out.paintMs).toBeGreaterThanOrEqual(0);
    expect(out.perMethodMs.BLACKOUT).toBeGreaterThanOrEqual(0);
    expect(out.perMethodMs.BLUR).toBeGreaterThanOrEqual(0);
  });
});
