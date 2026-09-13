// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { scanText } from "@/privacy/fusion";
import { pr, recordFragment, spanIou, wilson, pct } from "./helpers/metrics";

interface PiiEntity {
  type: string;
  start: number;
  end: number;
}

interface PiiItem {
  id: string;
  group: string;
  text: string;
  entities: PiiEntity[];
  note: string;
}

const SPAN_IOU = 0.5;

function loadCorpus(): PiiItem[] {
  const doc = JSON.parse(readFileSync(resolve(process.cwd(), "tests/metrics/fixtures/pii.json"), "utf-8"));
  return doc.items as PiiItem[];
}

export interface PiiMatch {
  itemId: string;
  expected: PiiEntity | null;
  found: { type: string; start: number; end: number } | null;
  kind: "tp" | "fp" | "fn";
}

export function matchItem(item: PiiItem): PiiMatch[] {
  const findings = scanText(item.text).map((f) => ({ type: f.type, start: f.start, end: f.end }));
  const used = new Set<number>();
  const out: PiiMatch[] = [];
  for (const e of item.entities) {
    let best = -1;
    let bestIou = 0;
    findings.forEach((f, i) => {
      if (used.has(i) || f.type !== e.type) return;
      const iou = spanIou(e.start, e.end, f.start, f.end);
      if (iou >= SPAN_IOU && iou > bestIou) {
        bestIou = iou;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      out.push({ itemId: item.id, expected: e, found: findings[best], kind: "tp" });
    } else {
      out.push({ itemId: item.id, expected: e, found: null, kind: "fn" });
    }
  }
  findings.forEach((f, i) => {
    if (!used.has(i)) out.push({ itemId: item.id, expected: null, found: f, kind: "fp" });
  });
  return out;
}

describe("pii metrics", () => {
  it("measures precision/recall per category over the CLEAR corpus", () => {
    const items = loadCorpus().filter((i) => i.group === "clear");
    const matches = items.flatMap(matchItem);
    const failures = matches.filter((m) => m.kind !== "tp");

    const byType = new Map<string, { tp: number; fp: number; fn: number; n: number }>();
    for (const m of matches) {
      const t = (m.expected ?? m.found)!.type;
      const e = byType.get(t) ?? { tp: 0, fp: 0, fn: 0, n: 0 };
      if (m.kind === "tp") e.tp++;
      if (m.kind === "fp") e.fp++;
      if (m.kind === "fn") e.fn++;
      e.n++;
      byType.set(t, e);
    }

    let tp = 0;
    let fp = 0;
    let fn = 0;
    const perCategory: Record<string, ReturnType<typeof pr> & { samples: number; ci95: [number, number] }> = {};
    for (const [t, e] of [...byType.entries()].sort()) {
      tp += e.tp;
      fp += e.fp;
      fn += e.fn;
      const m = pr(e.tp, e.fp, e.fn);
      perCategory[t] = { ...m, samples: e.n, ci95: wilson(m.precision, e.tp + e.fp) };
    }
    const micro = pr(tp, fp, fn);

    recordFragment("pii", {
      spanIouThreshold: SPAN_IOU,
      corpus: { clearItems: items.length, groups: ["clear"] },
      micro: { ...micro, precisionPct: pct(micro.precision), recallPct: pct(micro.recall), f1Pct: pct(micro.f1) },
      perCategory: Object.fromEntries(
        Object.entries(perCategory).map(([t, m]) => [
          t,
          { ...m, precisionPct: pct(m.precision), recallPct: pct(m.recall) },
        ]),
      ),
      failures: failures.map((f) => ({
        item: f.itemId,
        kind: f.kind,
        expected: f.expected,
        found: f.found,
        text: items.find((i) => i.id === f.itemId)?.text,
      })),
    });

    console.log(`[metrics:pii] n=${items.length} tp=${tp} fp=${fp} fn=${fn} P=${pct(micro.precision)}% R=${pct(micro.recall)}%`);
    for (const [t, m] of Object.entries(perCategory)) {
      console.log(`[metrics:pii]   ${t}: tp=${m.tp} fp=${m.fp} fn=${m.fn} P=${pct(m.precision)}% R=${pct(m.recall)}%`);
    }
    expect(failures).toEqual([]);
  });

  it("reports AMBIGUOUS shapes separately without touching headline numbers", () => {
    const items = loadCorpus().filter((i) => i.group === "ambiguous");
    expect(items.length).toBeGreaterThan(0);
    const observed = items.map((item) => ({
      id: item.id,
      text: item.text,
      note: item.note,
      findings: scanText(item.text).map((f) => ({ type: f.type, confidence: f.confidence, start: f.start, end: f.end })),
    }));
    recordFragment("pii-ambiguous", { items: observed });
    for (const o of observed) {
      console.log(`[metrics:pii-ambig] ${o.id}: ${JSON.stringify(o.findings)} (${o.note.slice(0, 60)}…)`);
    }
    expect(observed.every((o) => o.findings.length > 0)).toBe(true);
  });

  it("calculator determinism: same raw matches aggregate identically (TEST I)", () => {
    const items = loadCorpus().filter((i) => i.group === "clear");
    const run = () => {
      const m = items.flatMap(matchItem);
      return pr(m.filter((x) => x.kind === "tp").length, m.filter((x) => x.kind === "fp").length, m.filter((x) => x.kind === "fn").length);
    };
    expect(run()).toEqual(run());
  });
});
