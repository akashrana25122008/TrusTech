// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { planRedactions } from "@/privacy/redaction-planner";
import { renderRedactions } from "@/privacy/redaction-render";
import { buildManifest } from "@/privacy/redaction-manifest";
import { verifyRedaction } from "@/privacy/pixel-verify";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";
import { boxCovers, pct, recordFragment, wilson, type Box } from "./helpers/metrics";

interface RedScene {
  id: string;
  kind: string;
  size: { w: number; h: number };
  sensitive: Array<{ type: string; bbox: { x: number; y: number; w: number; h: number } }>;
  keep: Array<{ x: number; y: number; w: number; h: number }>;
}

const COVERAGE = 0.95;
const AREA_RATIO = 3;

function toBox(b: { x: number; y: number; w: number; h: number }): Box {
  return { x: b.x, y: b.y, width: b.w, height: b.h };
}

function paintScene(w: number, h: number, sensitive: RedScene["sensitive"], keep: RedScene["keep"]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 11;
    data[i + 1] = 17;
    data[i + 2] = 38;
    data[i + 3] = 255;
  }
  const fill = (b: { x: number; y: number; w: number; h: number }, c: [number, number, number]) => {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
      }
    }
  };
  for (const s of sensitive) fill(s.bbox, [18, 27, 56]);
  for (const k of keep) fill(k, [8, 145, 178]);
  return data;
}

describe("redaction metrics", () => {
  it("measures coverage, precision and over-redaction over the scene corpus", () => {
    const doc = JSON.parse(readFileSync(resolve(process.cwd(), "tests/metrics/fixtures/redaction.json"), "utf-8"));
    const scenes = doc.scenes as RedScene[];
    const rows: Array<{
      id: string;
      kind: string;
      gtBoxes: number;
      covered: number;
      appliedOps: number;
      correctOps: number;
      overRedacted: number;
      keepIntact: boolean;
      verified: boolean;
    }> = [];

    let gtTotal = 0;
    let gtCovered = 0;
    let opsTotal = 0;
    let opsCorrect = 0;

    for (const scene of scenes) {
      const regions: SensitiveRegion[] = scene.sensitive.map((s) => ({
        type: s.type,
        bbox: { x: s.bbox.x, y: s.bbox.y, width: s.bbox.w, height: s.bbox.h },
        confidence: 0.9,
        severity: severityFor(s.type as SensitiveRegion["type"], 0.9),
        source: "dom",
        sources: ["dom"],
        evidence: [],
        image: { width: scene.size.w, height: scene.size.h },
        normalized: { x: 0, y: 0, width: 0, height: 0 },
      })) as SensitiveRegion[];

      const pixels = paintScene(scene.size.w, scene.size.h, scene.sensitive, scene.keep);
      const plan = planRedactions(regions, { width: scene.size.w, height: scene.size.h });
      const rendered = renderRedactions({ width: scene.size.w, height: scene.size.h, data: pixels }, plan.operations);
      void buildManifest;
      const ops = rendered.applied.map((o) => toBox({ x: o.appliedBbox[0], y: o.appliedBbox[1], w: o.appliedBbox[2], h: o.appliedBbox[3] }));

      let covered = 0;
      for (const s of scene.sensitive) {
        const box = toBox(s.bbox);
        const best = Math.max(0, ...ops.map((o) => boxCovers(box, o)));
        if (best >= COVERAGE) covered++;
      }
      let correctOps = 0;
      let overRedacted = 0;
      for (const o of ops) {
        const coveredGt = scene.sensitive.filter((s) => boxCovers(toBox(s.bbox), o) >= COVERAGE);
        if (coveredGt.length > 0) {
          correctOps++;
          const union = coveredGt
            .map((s) => toBox(s.bbox))
            .reduce((acc, b) => {
              const x0 = Math.min(acc.x, b.x);
              const y0 = Math.min(acc.y, b.y);
              const x1 = Math.max(acc.x + acc.width, b.x + b.width);
              const y1 = Math.max(acc.y + acc.height, b.y + b.height);
              return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            });
          const unionArea = union.width * union.height;
          if (unionArea > 0 && (o.width * o.height) / unionArea > AREA_RATIO) overRedacted++;
        }
      }

      const out = rendered.data;
      const keepIntact = scene.keep.every((k) => {
        for (let y = k.y; y < k.y + k.h; y++) {
          for (let x = k.x; x < k.x + k.w; x++) {
            const i = (y * scene.size.w + x) * 4;
            if (out[i] !== pixels[i] || out[i + 1] !== pixels[i + 1] || out[i + 2] !== pixels[i + 2]) return false;
          }
        }
        return true;
      });

      const verification = verifyRedaction(
        { width: scene.size.w, height: scene.size.h, data: pixels },
        { width: rendered.width, height: rendered.height, data: rendered.data },
        rendered.applied,
        { version: "1", regions: rendered.applied.map((o) => ({ id: o.id, type: o.type, method: o.method, bbox: [...o.appliedBbox] as [number, number, number, number] })) },
      );

      gtTotal += scene.sensitive.length;
      gtCovered += covered;
      opsTotal += ops.length;
      opsCorrect += correctOps;
      rows.push({
        id: scene.id,
        kind: scene.kind,
        gtBoxes: scene.sensitive.length,
        covered,
        appliedOps: ops.length,
        correctOps,
        overRedacted,
        keepIntact,
        verified: verification.ok,
      });
      console.log(
        `[metrics:redaction] ${scene.id} covered=${covered}/${scene.sensitive.length} ops=${correctOps}/${ops.length} overRedacted=${overRedacted} keepIntact=${keepIntact} verified=${verification.ok}`,
      );
    }

    const coverageRecall = gtTotal > 0 ? gtCovered / gtTotal : 0;
    const precision = opsTotal > 0 ? opsCorrect / opsTotal : 1;
    const [plo, phi] = wilson(precision, opsTotal);
    const [rlo, rhi] = wilson(coverageRecall, gtTotal);

    recordFragment("redaction", {
      definition: {
        recall: "GT boxes with >=95% area covered / all GT boxes",
        precision: "applied ops covering >=95% of >=1 GT box / all applied ops",
        overRedaction: "applied op area > 3x union area of covered GT boxes",
      },
      scenes: rows.length,
      gtBoxes: gtTotal,
      coveredBoxes: gtCovered,
      appliedOps: opsTotal,
      correctOps: opsCorrect,
      recall: coverageRecall,
      recallPct: pct(coverageRecall),
      recallWilson95: [rlo, rhi],
      precision,
      precisionPct: pct(precision),
      precisionWilson95: [plo, phi],
      overRedactedOps: rows.reduce((a, r) => a + r.overRedacted, 0),
      rows,
    });

    console.log(`[metrics:redaction] recall=${pct(coverageRecall)}% precision=${pct(precision)}% overRedacted=${rows.reduce((a, r) => a + r.overRedacted, 0)}`);
    expect(rows.filter((r) => r.covered !== r.gtBoxes)).toEqual([]);
    expect(rows.filter((r) => r.correctOps !== r.appliedOps)).toEqual([]);
    expect(rows.filter((r) => r.overRedacted !== 0)).toEqual([]);
    expect(rows.filter((r) => !r.keepIntact)).toEqual([]);
    expect(rows.filter((r) => !r.verified)).toEqual([]);
  });
});
