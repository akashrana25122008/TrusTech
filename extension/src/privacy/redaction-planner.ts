/* ------------------------------------------------------------------ *
 * Redaction planner — SensitiveRegion[] → RedactionOperation[].
 *
 *   1. filter   by policy min-confidence
 *   2. resolve  deterministic method (policy floor enforced)
 *   3. pad      safety margin around the detector box
 *   4. clamp    into sanitized-image pixel coordinates (ints)
 *   5. drop     zero-area / fully-out-of-frame boxes (recorded, never
 *               silently ignored — off-frame means no pixels to leak)
 *   6. merge    overlapping operations: union bbox, stronger method
 *               wins, all merged types retained for the audit trail
 *   7. assign   deterministic ids (r1..rn) in final sort order
 *
 * Pure function of (regions, image, policy) → fully deterministic and
 * unit-testable. The SAME operation list feeds BOTH the pixel renderer
 * AND the manifest builder, so manifest/image divergence is impossible
 * by construction (§14).
 * ------------------------------------------------------------------ */

import {
  DEFAULT_REDACTION_POLICY,
  methodStrength,
  resolveMethod,
  type RedactionMethod,
  type RedactionPolicyConfig,
} from "./redaction-policy";
import type { RegionSeverity, SensitiveRegion, SensitiveType } from "./regions";

/** Sanitized-image pixel box: [x, y, width, height], integers, clamped. */
export type PixelBBox = [number, number, number, number];

export interface RedactionOperation {
  id: string;
  type: SensitiveType;
  method: RedactionMethod;
  /** Sanitized-image pixel coordinates (already padded + clamped). */
  bbox: PixelBBox;
  confidence: number;
  severity: RegionSeverity;
  /** Every sensitive type folded into this op by overlap merging. */
  mergedTypes: SensitiveType[];
}

export interface DroppedRegion {
  type: SensitiveType;
  severity: RegionSeverity;
  confidence: number;
  /** Machine-readable reason: below-confidence | zero-area | out-of-frame. */
  reason: "below-confidence" | "zero-area" | "out-of-frame" | "no-method";
}

export interface PlannedRedactions {
  operations: RedactionOperation[];
  dropped: DroppedRegion[];
  plannedMs: number;
}

export interface PlanImageSize {
  width: number;
  height: number;
}

const SEVERITY_RANK: Record<RegionSeverity, number> = { high: 3, medium: 2, low: 1 };

export function planRedactions(
  regions: readonly SensitiveRegion[],
  image: PlanImageSize,
  policy: RedactionPolicyConfig = DEFAULT_REDACTION_POLICY,
): PlannedRedactions {
  const t0 = performance.now();
  const dropped: DroppedRegion[] = [];

  interface Padded {
    type: SensitiveType;
    method: RedactionMethod;
    bbox: PixelBBox;
    confidence: number;
    severity: RegionSeverity;
  }
  const padded: Padded[] = [];

  for (const r of regions) {
    const method = resolveMethod(r.type, r.severity, r.confidence, policy);
    if (!method) {
      dropped.push({ type: r.type, severity: r.severity, confidence: r.confidence, reason: r.confidence < 0.5 ? "below-confidence" : "no-method" });
      continue;
    }
    const rule = policy.rules[r.type];
    const pad = Math.max(0, rule.padding);
    const x0 = Math.floor(r.bbox.x - pad);
    const y0 = Math.floor(r.bbox.y - pad);
    const x1 = Math.ceil(r.bbox.x + r.bbox.width + pad);
    const y1 = Math.ceil(r.bbox.y + r.bbox.height + pad);
    // Clamp into sanitized-image pixel coordinates.
    const cx0 = Math.max(0, Math.min(image.width, x0));
    const cy0 = Math.max(0, Math.min(image.height, y0));
    const cx1 = Math.max(0, Math.min(image.width, x1));
    const cy1 = Math.max(0, Math.min(image.height, y1));
    const w = cx1 - cx0;
    const h = cy1 - cy0;
    if (w <= 0 || h <= 0) {
      const fullyOutside = x1 <= 0 || y1 <= 0 || x0 >= image.width || y0 >= image.height;
      dropped.push({
        type: r.type,
        severity: r.severity,
        confidence: r.confidence,
        reason: fullyOutside ? "out-of-frame" : "zero-area",
      });
      continue;
    }
    padded.push({ type: r.type, method, bbox: [cx0, cy0, w, h], confidence: r.confidence, severity: r.severity });
  }

  // Deterministic order: stronger method → higher severity → higher
  // confidence → type name. Merging below is order-stable.
  padded.sort((a, b) => {
    const ms = methodStrength(b.method) - methodStrength(a.method);
    if (ms !== 0) return ms;
    const sv = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sv !== 0) return sv;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });

  // Greedy overlap merge: intersecting boxes fuse into their union with
  // the stronger method (security wins); every folded type is retained.
  interface Acc extends Padded {
    mergedTypes: SensitiveType[];
  }
  const foldInto = (target: Acc, source: Padded & { mergedTypes?: SensitiveType[] }): void => {
    target.bbox = unionPixel(target.bbox, source.bbox);
    for (const t of source.mergedTypes ?? [source.type]) {
      if (!target.mergedTypes.includes(t)) target.mergedTypes.push(t);
    }
    if (methodStrength(source.method) > methodStrength(target.method)) {
      target.method = source.method;
      target.type = source.type;
      target.severity = higherSeverity(target.severity, source.severity);
      target.confidence = Math.max(target.confidence, source.confidence);
    } else if (methodStrength(source.method) === methodStrength(target.method)) {
      // Same strength: keep the higher-severity representative.
      if (SEVERITY_RANK[source.severity] > SEVERITY_RANK[target.severity]) {
        target.type = source.type;
        target.severity = source.severity;
      }
      target.confidence = Math.max(target.confidence, source.confidence);
    }
    // Weaker method folded in: its pixels are covered by the union box
    // painted with the stronger method — nothing left uncovered.
  };
  const accepted: Acc[] = [];
  for (const p of padded) {
    const target = accepted.find((a) => boxesIntersect(a.bbox, p.bbox));
    if (!target) {
      accepted.push({ ...p, mergedTypes: [p.type] });
      continue;
    }
    foldInto(target, p);
  }

  // Fixpoint consolidation: union growth above can create NEW overlaps
  // with already-accepted ops (transitive overlap). Fuse until no two
  // ops share pixels — overlapping different-method ops would otherwise
  // corrupt each other's verification.
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < accepted.length; i++) {
      for (let j = i + 1; j < accepted.length; j++) {
        if (boxesIntersect(accepted[i].bbox, accepted[j].bbox)) {
          foldInto(accepted[i], accepted[j]);
          accepted.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }

  // Final deterministic order + ids.
  accepted.sort((a, b) => {
    const ms = methodStrength(b.method) - methodStrength(a.method);
    if (ms !== 0) return ms;
    const sv = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sv !== 0) return sv;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });

  const operations: RedactionOperation[] = accepted.map((a, i) => ({
    id: `r${i + 1}`,
    type: a.type,
    method: a.method,
    bbox: a.bbox,
    confidence: Math.round(a.confidence * 100) / 100,
    severity: a.severity,
    mergedTypes: [...a.mergedTypes].sort(),
  }));

  return { operations, dropped, plannedMs: Math.round((performance.now() - t0) * 100) / 100 };
}

function boxesIntersect(a: PixelBBox, b: PixelBBox): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function unionPixel(a: PixelBBox, b: PixelBBox): PixelBBox {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

function higherSeverity(a: RegionSeverity, b: RegionSeverity): RegionSeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}
