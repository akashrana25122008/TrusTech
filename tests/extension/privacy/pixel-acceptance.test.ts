// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { regionsAligned } from "@/privacy/coords";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * Phase 3 §21 + §31 — pixel-level acceptance on every Phase-2 fixture:
 * raw PNG in, GT regions redacted, sensitive boxes transformed, task
 * UI outside byte-identical, changed-pixel region measured.
 * ------------------------------------------------------------------ */

const FIXTURES = resolve(process.cwd(), "tests/fixtures/privacy");
const IDS = [
  "pwd-login",
  "aadhaar-form",
  "pan-tax",
  "card-checkout",
  "contact",
  "bank-ifsc",
  "gov-ids",
  "masked-clean",
  "photo-negative",
];

async function decodePng(name: string) {
  const buf = readFileSync(resolve(FIXTURES, name));
  const T = await import("@huggingface/transformers");
  const image = await T.RawImage.fromBlob(new Blob([new Uint8Array(buf)]));
  const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
  return { width: image.width as unknown as number, height: image.height as unknown as number, data };
}

describe("pixel acceptance on Phase-2 fixtures", () => {
  it("every fixture sanitizes with transformed sensitive boxes and intact surroundings", async () => {
    for (const id of IDS) {
      const png = await decodePng(`${id}.png`);
      const gt = JSON.parse(readFileSync(resolve(FIXTURES, `${id}.gt.json`), "utf-8"));
      const regions: SensitiveRegion[] = (gt.grounds as Array<{ type: string; bbox: { x: number; y: number; width: number; height: number } }>).map(
        (g) => ({
          type: g.type,
          bbox: { ...g.bbox },
          confidence: 0.9,
          severity: severityFor(g.type as SensitiveRegion["type"], 0.9),
          source: "dom",
          sources: ["dom"],
          evidence: [],
          image: { width: png.width, height: png.height },
          normalized: { x: 0, y: 0, width: 0, height: 0 },
        }) as SensitiveRegion,
      );

      const rawBytes = new Uint8ClampedArray(png.data);
      const capture = RawCapture.from(png.width, png.height, png.data);
      const { image } = sanitizeImage(capture, regions);

      expect(image.verification.ok, `${id} verification`).toBe(true);
// The planner merges overlapping same-box GT entries (e.g. contact's
      // PHONE/EMAIL/UPI share one paragraph box), so assert COVERAGE:
      // every GT box must be covered by ≥1 applied op of any method.
      for (const g of gt.grounds as Array<{ type: string; bbox: { x: number; y: number; width: number; height: number } }>) {
        const covered = image.manifest.regions.some((r) =>
          regionsAligned(
            { x: r.bbox[0], y: r.bbox[1], width: r.bbox[2], height: r.bbox[3] },
            g.bbox,
          ),
        );
        expect(covered, `${id} GT ${g.type} must be covered by a redaction op`).toBe(true);
      }

      // Changed-pixel region measurement.
      const out = new Uint8ClampedArray(image.data);
      let changed = 0;
      for (let i = 0; i < out.length; i += 4) {
        if (out[i] !== rawBytes[i] || out[i + 1] !== rawBytes[i + 1] || out[i + 2] !== rawBytes[i + 2]) changed++;
      }
      if (regions.length > 0) {
        expect(changed, `${id} must transform pixels`).toBeGreaterThan(0);
      } else {
        expect(changed, `${id} clean image must be byte-identical`).toBe(0);
      }
      const changedPct = ((changed / (png.width * png.height)) * 100).toFixed(2);
      console.log(`[pixel-acceptance] ${id}: ops=${image.manifest.regions.length} changed=${changedPct}% verifyMs=${image.verification.verifyMs}ms`);

      image.dispose();
      capture.dispose();
    }
  }, 120_000);
});
