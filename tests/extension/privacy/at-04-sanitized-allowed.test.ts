// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ImageTransmissionGate } from "@/privacy/image-gate";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";

/* ------------------------------------------------------------------ *
 * AT-04 — SANITIZED IMAGE APPROVAL (acceptance, real fixtures + real
 * pixels, mock fetch as the network observation point).
 *
 *   raw PNG ──► GT regions ──► plan ──► BLACKOUT/MASK ──► verify ──►
 *   manifest validate ──► gate ──► ALLOW (sanitized bytes on the wire,
 *   raw bytes never transmitted)
 *
 * Checks every box in §30: raw not transmitted; sanitization done;
 * manifest generated + matches ops; pixel verification passed;
 * sanitized transmitted; sensitive pixels transformed; task UI intact.
 * ------------------------------------------------------------------ */

const FIXTURES = resolve(process.cwd(), "tests/fixtures/privacy");

interface GtEntry {
  type: string;
  bbox: { x: number; y: number; width: number; height: number };
}

async function loadPngRgbaAsync(name: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const buf = readFileSync(resolve(FIXTURES, name));
  const T = await import("@huggingface/transformers");
  const image = await T.RawImage.fromBlob(new Blob([new Uint8Array(buf)]));
  const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
  return { width: image.width as unknown as number, height: image.height as unknown as number, data };
}

function gtRegions(id: string, image: { width: number; height: number }): SensitiveRegion[] {
  const gt = JSON.parse(readFileSync(resolve(FIXTURES, `${id}.gt.json`), "utf-8"));
  return (gt.grounds as GtEntry[]).map((g) => {
    const confidence = 0.9;
    return {
      type: g.type,
      bbox: { ...g.bbox },
      confidence,
      severity: severityFor(g.type as SensitiveRegion["type"], confidence),
      source: "dom",
      sources: ["dom"],
      evidence: [],
      image: { ...image },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    } as SensitiveRegion;
  });
}

describe("AT-04 — sanitized image approval", () => {
  it("full boundary on card-checkout + pwd-login fixtures", async () => {
    const sent: Array<{ url: string; body: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    });
    const gate = new ImageTransmissionGate({ baseUrl: "http://localhost:8000", fetchFn: fetchFn as typeof fetch });

    for (const id of ["card-checkout", "pwd-login"]) {
      const png = await loadPngRgbaAsync(`${id}.png`);
      const rawBytes = new Uint8ClampedArray(png.data); // snapshot of RAW
      const capture = RawCapture.from(png.width, png.height, png.data);
      const regions = gtRegions(id, png);

      // sanitize → verify → manifest (single pipeline call)
      const { image } = sanitizeImage(capture, regions);
      expect(image.verification.ok).toBe(true);
      expect(image.manifest.regions.length).toBe(regions.length);

      // gate
      const res = await gate.sendSanitized(image);
      expect(res.verdict).toBe("ALLOW");
      expect(res.transmitted).toBe(true);

      // the wire bytes are the SANITIZED image, never the raw bytes
      const wire = JSON.parse(sent[sent.length - 1].body);
      expect(wire.manifest).toEqual(image.manifest);
      const wirePng = Buffer.from(wire.image.split(",")[1], "base64");
      const T = await import("@huggingface/transformers");
      const decoded = await T.RawImage.fromBlob(new Blob([new Uint8Array(wirePng)]));
      const wireData = new Uint8ClampedArray(decoded.data);
      expect(wireData.length).toBe(rawBytes.length);

      // sensitive boxes transformed vs raw …
      for (const op of image.manifest.regions) {
        const [x, y, w, h] = op.bbox;
        let same = 0;
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            const i = (yy * png.width + xx) * 4;
            if (
              wireData[i] === rawBytes[i] &&
              wireData[i + 1] === rawBytes[i + 1] &&
              wireData[i + 2] === rawBytes[i + 2]
            ) {
              same++;
            }
          }
        }
        expect(same, `${id} ${op.id} must not retain raw pixels`).toBe(0);
      }
      // … and task UI outside the boxes is byte-identical.
      const covered = new Uint8Array(png.width * png.height);
      for (const op of image.manifest.regions) {
        const [x, y, w, h] = op.bbox;
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) covered[yy * png.width + xx] = 1;
      }
      let outsideDiff = 0;
      for (let p = 0; p < covered.length; p++) {
        if (covered[p] === 1) continue;
        const i = p * 4;
        if (wireData[i] !== rawBytes[i] || wireData[i + 1] !== rawBytes[i + 1] || wireData[i + 2] !== rawBytes[i + 2]) {
          outsideDiff++;
        }
      }
      expect(outsideDiff, `${id} task UI must be preserved`).toBe(0);

      console.log(
        `[AT-04] ${id}: ALLOW, regions=${image.manifest.regions.map((r) => `${r.type}/${r.method}`).join(",")}, ` +
          `verifyMs=${image.verification.verifyMs}ms sanitizeMs=${image.sanitizeMs}ms wireBytes=${sent[sent.length - 1].body.length}`,
      );
      image.dispose();
      capture.dispose();
    }
    expect(sent).toHaveLength(2);
  }, 120_000);
});
