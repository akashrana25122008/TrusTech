/* ------------------------------------------------------------------ *
 * Pixel verification — engineering proof that the intended redaction
 * was ACTUALLY applied to the exported pixels.
 *
 * Checks, per applied operation:
 *   BLACKOUT — every pixel in the box equals the policy fill, exactly.
 *   MASK     — every pixel equals the deterministic pattern, exactly.
 *   BLUR     — the region was transformed: on non-uniform regions a
 *              minimum fraction of pixels must differ AND variance must
 *              drop; on uniform regions (nothing to reconstruct) the op
 *              passes with a recorded note.
 * Global checks:
 *   - output dimensions match the raw capture
 *   - every pixel OUTSIDE all applied boxes is byte-identical (task UI
 *     preservation is verified, not assumed)
 *   - manifest regions match applied operations exactly (id/type/method/
 *     bbox) — declared redaction is tied to actual pixels (§33)
 *
 * No claim of information-theoretic irreversibility is made; the goal
 * is robust verification that the pipeline did what the manifest says.
 * Any failure → BLOCK (fail closed).
 * ------------------------------------------------------------------ */

import {
  DEFAULT_REDACTION_POLICY,
  type RedactionPolicyConfig,
} from "./redaction-policy";
import { expectedMaskPixel } from "./redaction-render";
import type { AppliedOperation } from "./redaction-render";
import { manifestsEqual, type RedactionManifest } from "./redaction-manifest";

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PixelVerification {
  ok: boolean;
  checks: VerificationCheck[];
  failures: string[];
  /** Pixels examined inside redacted boxes. */
  redactedPixels: number;
  /** Pixels confirmed byte-identical outside redacted boxes. */
  preservedPixels: number;
  verifyMs: number;
}

export function verifyRedaction(
  raw: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  out: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  applied: readonly AppliedOperation[],
  manifest: RedactionManifest,
  policy: RedactionPolicyConfig = DEFAULT_REDACTION_POLICY,
): PixelVerification {
  const t0 = performance.now();
  const checks: VerificationCheck[] = [];
  const failures: string[] = [];
  let redactedPixels = 0;
  let preservedPixels = 0;

  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  if (raw.width !== out.width || raw.height !== out.height) {
    check("dimensions", false, `raw ${raw.width}x${raw.height} != out ${out.width}x${out.height}`);
    return finish(false, checks, failures, 0, 0, t0);
  }
  check("dimensions", true, `${out.width}x${out.height}`);
  if (raw.data.length !== out.data.length) {
    check("buffer-length", false, `raw ${raw.data.length} != out ${out.data.length}`);
    return finish(false, checks, failures, 0, 0, t0);
  }

  // Coverage map: which pixels were supposed to change.
  const covered = new Uint8Array(out.width * out.height);
  for (const op of applied) {
    const [x, y, w, h] = op.appliedBbox;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) covered[yy * out.width + xx] = 1;
    }
  }

  for (const op of applied) {
    const [x, y, w, h] = op.appliedBbox;
    if (op.method === "BLACKOUT") {
      const [r, g, b, a] = policy.blackoutColor;
      let bad = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * out.width + xx) * 4;
          if (out.data[i] !== r || out.data[i + 1] !== g || out.data[i + 2] !== b || out.data[i + 3] !== a) bad++;
        }
      }
      redactedPixels += w * h;
      check(`blackout:${op.id}`, bad === 0, bad === 0 ? `${w * h} px exact fill` : `${bad}/${w * h} px differ from fill`);
    } else if (op.method === "MASK") {
      let bad = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * out.width + xx) * 4;
          const [r, g, b, a] = expectedMaskPixel(xx, yy, policy.maskColor, policy.maskAccent);
          if (out.data[i] !== r || out.data[i + 1] !== g || out.data[i + 2] !== b || out.data[i + 3] !== a) bad++;
        }
      }
      redactedPixels += w * h;
      check(`mask:${op.id}`, bad === 0, bad === 0 ? `${w * h} px exact pattern` : `${bad}/${w * h} px differ from pattern`);
      // Belt-and-braces: masked pixels must also differ from the original
      // wherever the original was non-uniform (a pattern pixel could
      // theoretically coincide with an original pixel).
      let same = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * out.width + xx) * 4;
          if (
            out.data[i] === raw.data[i] &&
            out.data[i + 1] === raw.data[i + 1] &&
            out.data[i + 2] === raw.data[i + 2] &&
            out.data[i + 3] === raw.data[i + 3]
          ) {
            same++;
          }
        }
      }
      check(
        `mask-divergence:${op.id}`,
        same === 0,
        same === 0 ? "no pixel retains its original value" : `${same}/${w * h} px unchanged vs raw`,
      );
    } else {
      // BLUR: variance + changed-fraction analysis.
      let n = 0;
      let changed = 0;
      let rawMean = 0;
      let outMean = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * out.width + xx) * 4;
          const rl = 0.299 * raw.data[i] + 0.587 * raw.data[i + 1] + 0.114 * raw.data[i + 2];
          const ol = 0.299 * out.data[i] + 0.587 * out.data[i + 1] + 0.114 * out.data[i + 2];
          rawMean += rl;
          outMean += ol;
          if (
            out.data[i] !== raw.data[i] ||
            out.data[i + 1] !== raw.data[i + 1] ||
            out.data[i + 2] !== raw.data[i + 2]
          ) {
            changed++;
          }
          n++;
        }
      }
      rawMean /= Math.max(1, n);
      outMean /= Math.max(1, n);
      let rawVar = 0;
      let outVar = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * out.width + xx) * 4;
          const rl = 0.299 * raw.data[i] + 0.587 * raw.data[i + 1] + 0.114 * raw.data[i + 2];
          const ol = 0.299 * out.data[i] + 0.587 * out.data[i + 1] + 0.114 * out.data[i + 2];
          rawVar += (rl - rawMean) * (rl - rawMean);
          outVar += (ol - outMean) * (ol - outMean);
        }
      }
      rawVar /= Math.max(1, n);
      outVar /= Math.max(1, n);
      redactedPixels += n;
      const fraction = n > 0 ? changed / n : 0;
      if (rawVar < 1e-6) {
        check(`blur:${op.id}`, true, `uniform region (var≈0) — nothing reconstructible; ${changed}/${n} px changed`);
      } else {
        const ok = fraction >= policy.blurChangedFraction && outVar <= rawVar;
        check(
          `blur:${op.id}`,
          ok,
          `changed ${(fraction * 100).toFixed(1)}% (need ≥${(policy.blurChangedFraction * 100).toFixed(1)}%), var ${rawVar.toFixed(1)}→${outVar.toFixed(1)}`,
        );
      }
    }
  }

  // Outside every applied box, pixels must be byte-identical: task UI
  // preservation verified, and proof nothing else was touched.
  let outsideBad = 0;
  let outside = 0;
  for (let p = 0; p < covered.length; p++) {
    if (covered[p] === 1) continue;
    outside++;
    const i = p * 4;
    if (
      out.data[i] !== raw.data[i] ||
      out.data[i + 1] !== raw.data[i + 1] ||
      out.data[i + 2] !== raw.data[i + 2] ||
      out.data[i + 3] !== raw.data[i + 3]
    ) {
      outsideBad++;
      if (outsideBad > 16) break; // cap work; one bad pixel already fails
    }
  }
  preservedPixels = outside - Math.min(outsideBad, outside);
  check("outside-untouched", outsideBad === 0, outsideBad === 0 ? `${outside} px identical` : `${outsideBad}+ px outside boxes were modified`);

  // Manifest ↔ applied-ops consistency: declared == actual.
  const manifestOps: AppliedOperation[] = manifest.regions.map((r) => ({
    id: r.id,
    type: r.type,
    method: r.method,
    bbox: [...r.bbox] as [number, number, number, number],
    appliedBbox: [...r.bbox] as [number, number, number, number],
    confidence: 1,
    severity: "high" as const,
    mergedTypes: [r.type],
  }));
  const consistent =
    manifestsEqual(manifest, {
      version: manifest.version,
      regions: applied.map((o) => ({ id: o.id, type: o.type, method: o.method, bbox: [...o.appliedBbox] as [number, number, number, number] })),
    }) && manifestOps.length === applied.length;
  check("manifest-consistent", consistent, consistent ? `${manifest.regions.length} regions match applied ops` : "manifest does not match applied operations");

  return finish(failures.length === 0, checks, failures, redactedPixels, preservedPixels, t0);
}

function finish(
  ok: boolean,
  checks: VerificationCheck[],
  failures: string[],
  redactedPixels: number,
  preservedPixels: number,
  t0: number,
): PixelVerification {
  return {
    ok,
    checks,
    failures,
    redactedPixels,
    preservedPixels,
    verifyMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}
