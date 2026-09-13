/* ------------------------------------------------------------------ *
 * Pixel renderer — applies RedactionOperation[] to a REAL RGBA buffer.
 *
 * This is pixel surgery, not a UI overlay: the returned buffer IS the
 * sanitized image. The original buffer is never mutated (copy-on-write),
 * so a failed render cannot corrupt the caller's raw capture.
 *
 *   BLACKOUT — deterministic opaque fill. Original pixels cease to exist.
 *   MASK     — deterministic opaque pattern (base + hatch). Original
 *              pixels cease to exist; limited context shape retained.
 *   BLUR     — box blur (radius from policy) sampled over an expanded,
 *              edge-clamped window. Pixels are really transformed.
 *
 * Pure function of (pixels, ops, policy): no canvas, no DOM, runs in
 * content scripts, workers, panel, and node tests identically.
 * ------------------------------------------------------------------ */

import {
  DEFAULT_REDACTION_POLICY,
  type RedactionMethod,
  type RedactionPolicyConfig,
} from "./redaction-policy";
import type { PixelBBox, RedactionOperation } from "./redaction-planner";

export interface RgbaSource {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface AppliedOperation extends RedactionOperation {
  /** Pixels actually painted (clamped; equals op.bbox by construction). */
  appliedBbox: PixelBBox;
}

export interface RenderOutput {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  applied: AppliedOperation[];
  paintMs: number;
  perMethodMs: Partial<Record<RedactionMethod, number>>;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export function renderRedactions(
  src: RgbaSource,
  operations: readonly RedactionOperation[],
  policy: RedactionPolicyConfig = DEFAULT_REDACTION_POLICY,
): RenderOutput {
  const t0 = performance.now();
  const { width, height } = src;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`renderRedactions: bad dimensions ${width}x${height}`);
  }
  if (src.data.length !== width * height * 4) {
    throw new Error(`renderRedactions: buffer length ${src.data.length} != ${width}x${height}x4`);
  }

  const dst = new Uint8ClampedArray(src.data);
  const perMethodMs: Partial<Record<RedactionMethod, number>> = {};
  const applied: AppliedOperation[] = [];

  for (const op of operations) {
    const m0 = performance.now();
    const [x, y, w, h] = op.bbox;
    // Belt-and-braces clamp (planner already clamped; renderer never trusts).
    const x0 = clampInt(x, 0, width);
    const y0 = clampInt(y, 0, height);
    const x1 = clampInt(x + w, 0, width);
    const y1 = clampInt(y + h, 0, height);
    if (x1 <= x0 || y1 <= y0) {
      throw new Error(`renderRedactions: ${op.id} has empty clamped box`);
    }
    if (op.method === "BLACKOUT") paintBlackout(dst, width, x0, y0, x1, y1, policy.blackoutColor);
    else if (op.method === "MASK") paintMask(dst, width, x0, y0, x1, y1, policy.maskColor, policy.maskAccent);
    else paintBlur(src.data, dst, width, height, x0, y0, x1, y1, policy.blurRadius);
    perMethodMs[op.method] = (perMethodMs[op.method] ?? 0) + (performance.now() - m0);
    applied.push({ ...op, appliedBbox: [x0, y0, x1 - x0, y1 - y0] });
  }

  const perRounded: Partial<Record<RedactionMethod, number>> = {};
  for (const [k, v] of Object.entries(perMethodMs)) perRounded[k as RedactionMethod] = Math.round(v * 100) / 100;
  return {
    width,
    height,
    data: dst,
    applied,
    paintMs: Math.round((performance.now() - t0) * 100) / 100,
    perMethodMs: perRounded,
  };
}

type RGBA = [number, number, number, number];

function paintBlackout(dst: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number, color: RGBA): void {
  const [r, g, b, a] = color;
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++) {
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = a;
      i += 4;
    }
  }
}

function paintMask(
  dst: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  base: RGBA,
  accent: RGBA,
): void {
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++) {
      // Deterministic diagonal hatch: opaque everywhere, pattern fixed.
      const hatch = (x + y) % 8 < 2;
      const c = hatch ? accent : base;
      dst[i] = c[0];
      dst[i + 1] = c[1];
      dst[i + 2] = c[2];
      dst[i + 3] = c[3];
      i += 4;
    }
  }
}

/** Box blur over the op box, sampling an expanded window (radius r on
 *  each side) from the ORIGINAL source so edges blend instead of
 *  clamping to a hard rim. Writes cover exactly the op box. */
function paintBlur(
  src: Uint8ClampedArray | Uint8Array,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): void {
  const r = Math.max(1, Math.min(32, Math.floor(radius)));
  const sx0 = Math.max(0, x0 - r);
  const sy0 = Math.max(0, y0 - r);
  const sx1 = Math.min(width, x1 + r);
  const sy1 = Math.min(height, y1 + r);
  const d = 2 * r + 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      let n = 0;
      // Window centered on (x,y), clamped to the EXPANDED source window.
      const wx0 = Math.max(sx0, x - r);
      const wy0 = Math.max(sy0, y - r);
      const wx1 = Math.min(sx1, x + r + 1);
      const wy1 = Math.min(sy1, y + r + 1);
      for (let wy = wy0; wy < wy1; wy++) {
        let i = (wy * width + wx0) * 4;
        for (let wx = wx0; wx < wx1; wx++) {
          rs += src[i];
          gs += src[i + 1];
          bs += src[i + 2];
          as += src[i + 3];
          i += 4;
          n++;
        }
      }
      void d;
      const o = (y * width + x) * 4;
      dst[o] = Math.round(rs / n);
      dst[o + 1] = Math.round(gs / n);
      dst[o + 2] = Math.round(bs / n);
      dst[o + 3] = Math.round(as / n);
    }
  }
}

/** Recompute the exact expected pixel for MASK verification (mirrors
 *  paintMask — single source of truth lives here, next to the painter). */
export function expectedMaskPixel(
  x: number,
  y: number,
  base: RGBA,
  accent: RGBA,
): RGBA {
  return (x + y) % 8 < 2 ? accent : base;
}
