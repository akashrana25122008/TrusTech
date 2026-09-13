import { describe, it, expect } from "vitest";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import type { SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * Phase 3 §22 — task-relevant UI preservation regressions.
 *
 * Login scene:  sensitive password field + non-sensitive Login button.
 * Card scene:   sensitive card number  + merchant / amount / pay button.
 *
 * Expected: sensitive rects fully redacted, useful UI byte-identical.
 * ------------------------------------------------------------------ */

const W = 320;
const H = 200;

type RGBA = [number, number, number, number];
const INK: RGBA = [230, 236, 248, 255];
const FIELD: RGBA = [18, 27, 56, 255];
const ACCENT: RGBA = [8, 145, 178, 255];
const BG: RGBA = [11, 17, 38, 255];

function paintScene(rects: Array<{ x: number; y: number; w: number; h: number; c: RGBA }>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = BG[0];
      data[i + 1] = BG[1];
      data[i + 2] = BG[2];
      data[i + 3] = BG[3];
    }
  }
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * W + x) * 4;
        data[i] = r.c[0];
        data[i + 1] = r.c[1];
        data[i + 2] = r.c[2];
        data[i + 3] = r.c[3];
      }
    }
  }
  return data;
}

function region(type: SensitiveRegion["type"], x: number, y: number, w: number, h: number): SensitiveRegion {
  return {
    type,
    bbox: { x, y, width: w, height: h },
    confidence: 0.95,
    severity: "high",
    source: "dom",
    sources: ["dom"],
    evidence: [],
    image: { width: W, height: H },
    normalized: { x: 0, y: 0, width: 0, height: 0 },
  } as SensitiveRegion;
}

function assertRectByteEqual(a: Uint8ClampedArray, b: Uint8ClampedArray, x: number, y: number, w: number, h: number, label: string) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      expect([a[i], a[i + 1], a[i + 2], a[i + 3]], `${label} @${xx},${yy}`).toEqual([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    }
  }
}

function assertRectNotOriginal(raw: Uint8ClampedArray, out: Uint8ClampedArray, x: number, y: number, w: number, h: number, label: string) {
  let same = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      if (raw[i] === out[i] && raw[i + 1] === out[i + 1] && raw[i + 2] === out[i + 2]) same++;
    }
  }
  expect(same, `${label} must not retain raw pixels`).toBe(0);
}

describe("task-relevant UI preservation", () => {
  it("login: password field redacted, Login button + labels preserved", () => {
    // Password field at (40,60,200x36); Login button at (40,120,120x32);
    // greeting text bar at (40,24,160x10).
    const data = paintScene([
      { x: 40, y: 60, w: 200, h: 36, c: FIELD },
      { x: 40, y: 120, w: 120, h: 32, c: ACCENT },
      { x: 40, y: 24, w: 160, h: 10, c: INK },
    ]);
    const capture = RawCapture.from(W, H, data);
    const { image } = sanitizeImage(capture, [region("PASSWORD", 40, 60, 200, 36)]);
    expect(image.verification.ok).toBe(true);
    const out = new Uint8ClampedArray(image.data);

    // The padded op box covers the field: assert the whole GT field is gone…
    assertRectNotOriginal(data, out, 40, 60, 200, 36, "password field");
    // …and the useful UI is byte-identical.
    assertRectByteEqual(data, out, 40, 120, 120, 32, "login button");
    assertRectByteEqual(data, out, 40, 24, 160, 10, "greeting bar");
    image.dispose();
    capture.dispose();
  });

  it("checkout: card number redacted, merchant/amount/pay preserved", () => {
    // Card field (40,40,220x32); merchant bar (40,12,140x10);
    // amount bar (40,88,80x10); pay button (40,140,140x32).
    const data = paintScene([
      { x: 40, y: 40, w: 220, h: 32, c: FIELD },
      { x: 40, y: 12, w: 140, h: 10, c: INK },
      { x: 40, y: 88, w: 80, h: 10, c: INK },
      { x: 40, y: 140, w: 140, h: 32, c: ACCENT },
    ]);
    const capture = RawCapture.from(W, H, data);
    const { image } = sanitizeImage(capture, [region("CARD_NUMBER", 40, 40, 220, 32)]);
    expect(image.verification.ok).toBe(true);
    const out = new Uint8ClampedArray(image.data);

    assertRectNotOriginal(data, out, 40, 40, 220, 32, "card number");
    assertRectByteEqual(data, out, 40, 12, 140, 10, "merchant");
    assertRectByteEqual(data, out, 40, 88, 80, 10, "amount");
    assertRectByteEqual(data, out, 40, 140, 140, 32, "pay button");
    image.dispose();
    capture.dispose();
  });
});
