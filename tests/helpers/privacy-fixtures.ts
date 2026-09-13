import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RegionBBox, SensitiveRegion } from "@/privacy/regions";
import { iouRect } from "@/privacy/coords";

/* ------------------------------------------------------------------ *
 * AT-02 support helpers — fixture loading, GT matching, per-class
 * precision / recall / FP / FN aggregation.
 * ------------------------------------------------------------------ */

export interface GroundTruthBox {
  type: string;
  bbox: RegionBBox;
  minIoU?: number;
}

export interface PrivacyFixture {
  id: string;
  html: string;
  pngBuffer: Buffer;
  viewport: { width: number; height: number };
  groundTruth: GroundTruthBox[];
  masked: string[];
  notes: string;
}

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/privacy");

export function fixtureIds(): string[] {
  const ids = [
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
  return ids;
}

export function loadFixture(id: string): PrivacyFixture {
  const html = readFileSync(resolve(FIXTURE_DIR, `${id}.html`), "utf-8");
  const pngBuffer = readFileSync(resolve(FIXTURE_DIR, `${id}.png`));
  const gt = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${id}.gt.json`), "utf-8"));
  return {
    id,
    html,
    pngBuffer,
    viewport: gt.viewport,
    groundTruth: gt.grounds.map((g: { type: string; bbox: RegionBBox; minIoU?: number }) => ({
      type: g.type,
      bbox: g.bbox,
      minIoU: g.minIoU ?? 0.3,
    })),
    masked: gt.masked ?? [],
    notes: gt.notes ?? "",
  };
}

/** Read an element's layout from its data-rect attribute (jsdom has no layout). */
export function readLayoutRect(el: Element): RegionBBox {
  const raw = el.getAttribute("data-rect");
  if (!raw) return { x: 0, y: 0, width: 0, height: 0 };
  const [x, y, w, h] = raw.split(",").map(Number);
  return { x, y, width: w, height: h };
}

export interface MatchResult {
  matchedPairs: Array<{ predIdx: number; gtIdx: number; type: string }>;
  unmatchedPreds: SensitiveRegion[];
  unmatchedGT: GroundTruthBox[];
}

/** Match predicted regions to ground truth by same type + IoU threshold. */
export function matchRegionsToGT(regions: SensitiveRegion[], gt: GroundTruthBox[]): MatchResult {
  const usedPred = new Set<number>();
  const usedGT = new Set<number>();
  const matchedPairs: MatchResult["matchedPairs"] = [];

  for (let gi = 0; gi < gt.length; gi++) {
    const g = gt[gi];
    let bestIdx = -1;
    let best = -1;
    for (let pi = 0; pi < regions.length; pi++) {
      if (usedPred.has(pi)) continue;
      if (regions[pi].type !== g.type) continue;
      const iou = iouRect(regions[pi].bbox, g.bbox);
      if (iou >= (g.minIoU ?? 0.3) && iou > best) {
        best = iou;
        bestIdx = pi;
      }
    }
    if (bestIdx >= 0) {
      usedPred.add(bestIdx);
      usedGT.add(gi);
      matchedPairs.push({ predIdx: bestIdx, gtIdx: gi, type: g.type });
    }
  }

  return {
    matchedPairs,
    unmatchedPreds: regions.filter((_, i) => !usedPred.has(i)),
    unmatchedGT: gt.filter((_, i) => !usedGT.has(i)).map((g) => ({ type: g.type, bbox: g.bbox })),
  };
}

export interface ClassMetric {
  tp: number;
  fp: number;
  fn: number;
  precision: number; // tp / (tp + fp)
  recall: number; // tp / (tp + fn)
}

export function classMetrics(result: MatchResult): Record<string, ClassMetric> {
  const m: Record<string, ClassMetric> = {};
  const init = (t: string) => {
    if (!m[t]) m[t] = { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0 };
  };
  for (const p of result.matchedPairs) {
    init(p.type);
    m[p.type].tp++;
  }
  for (const p of result.unmatchedPreds) {
    init(p.type);
    m[p.type].fp++;
  }
  for (const p of result.unmatchedGT) {
    init(p.type);
    m[p.type].fn++;
  }
  for (const k of Object.keys(m)) {
    const v = m[k];
    v.precision = v.tp + v.fp > 0 ? v.tp / (v.tp + v.fp) : 0;
    v.recall = v.tp + v.fn > 0 ? v.tp / (v.tp + v.fn) : 0;
  }
  return m;
}

/** Aggregate n per-fixture MatchResults into one per-class table. */
export function aggregateMetrics(results: MatchResult[], classes: string[]): Record<string, ClassMetric> {
  const agg: Record<string, ClassMetric> = {};
  for (const c of classes) agg[c] = { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0 };
  for (const r of results) {
    const perClass = classMetrics(r);
    for (const c of classes) {
      const entry = perClass[c];
      if (!entry) continue;
      agg[c].tp += entry.tp;
      agg[c].fp += entry.fp;
      agg[c].fn += entry.fn;
    }
  }
  for (const c of classes) {
    const v = agg[c];
    v.precision = v.tp + v.fp > 0 ? v.tp / (v.tp + v.fp) : 0;
    v.recall = v.tp + v.fn > 0 ? v.tp / (v.tp + v.fn) : 0;
  }
  return agg;
}