import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const REPORTS = resolve(ROOT, "tests/metrics/reports");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function commit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function pct01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "INSUFFICIENT DATA";
  return `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
}

function ms(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "INSUFFICIENT DATA";
  return `${v.toFixed(v < 10 ? 2 : 0)} ms`;
}

function main() {
  const fragments = {};
  for (const file of readdirSync(REPORTS)) {
    if (!file.startsWith("fragment-") || !file.endsWith(".json")) continue;
    const frag = readJson(resolve(REPORTS, file));
    fragments[frag.name] = frag.data;
  }
  const required = ["vision", "vision-model", "pii", "pii-ambiguous", "redaction", "latency", "resources"];
  const missing = required.filter((k) => !(k in fragments));
  if (missing.length > 0) {
    console.error(`missing fragments (run the metrics suite first): ${missing.join(", ")}`);
    process.exit(1);
  }

  const vision = fragments.vision;
  const visionModel = fragments["vision-model"];
  const pii = fragments.pii;
  const piiAmbig = fragments["pii-ambiguous"];
  const redaction = fragments.redaction;
  const latency = fragments.latency;
  const resources = fragments.resources;

  const weightedInputs = {
    visionAccuracy: vision.accuracy,
    piiF1: pii.micro.f1,
    redactionPrecision: redaction.precision,
    resourceScore: null,
    latencyScore: null,
  };
  const memDelta = resources.memory?.peakDeltaMb;
  const e2eMedian = latency.stages?.e2e?.median;
  if (typeof memDelta === "number") {
    weightedInputs.resourceScore = Math.max(0, 1 - memDelta / 500);
  }
  if (typeof e2eMedian === "number") {
    weightedInputs.latencyScore = Math.max(0, 1 - e2eMedian / 30000);
  }
  const weights = { visionAccuracy: 0.25, piiF1: 0.2, redactionPrecision: 0.2, resourceScore: 0.2, latencyScore: 0.15 };
  const missingInputs = Object.entries(weightedInputs)
    .filter(([, v]) => typeof v !== "number")
    .map(([k]) => k);
  const weightedScore =
    missingInputs.length === 0
      ? Object.entries(weights).reduce((a, [k, w]) => a + weightedInputs[k] * w, 0)
      : null;

  const results = {
    generatedAt: new Date().toISOString(),
    commit: commit(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    visionAccuracy: {
      value: vision.accuracy,
      display: pct01(vision.accuracy),
      fixtures: vision.fixtures,
      passed: vision.passed,
      wilson95: vision.wilson95,
      status: "MEASURED",
    },
    visionModel: {
      note: visionModel.note,
      image: visionModel.image,
      detections: visionModel.detections?.length ?? null,
      catsDetected: visionModel.catDetections,
      knownTargets: visionModel.knownTargetsPresent,
      inferenceMs: visionModel.inferenceMs,
      status: "MEASURED",
    },
    pii: {
      precision: pii.micro.precision,
      precisionDisplay: pct01(pii.micro.precision),
      recall: pii.micro.recall,
      recallDisplay: pct01(pii.micro.recall),
      f1: pii.micro.f1,
      tp: pii.micro.tp,
      fp: pii.micro.fp,
      fn: pii.micro.fn,
      clearItems: pii.corpus.clearItems,
      perCategory: pii.perCategory,
      failures: pii.failures,
      ambiguousTrackedSeparately: piiAmbig.items.length,
      status: "MEASURED",
    },
    redaction: {
      precision: redaction.precision,
      precisionDisplay: pct01(redaction.precision),
      recall: redaction.recall,
      recallDisplay: pct01(redaction.recall),
      gtBoxes: redaction.gtBoxes,
      appliedOps: redaction.appliedOps,
      overRedactedOps: redaction.overRedactedOps,
      status: "MEASURED",
    },
    latency: { stages: latency.stages, definition: latency.definition, status: "MEASURED" },
    resources: { ...resources, status: "MEASURED" },
    unsupportedCategories: {
      status: "INSUFFICIENT DATA",
      detail: "API keys and auth tokens have no PII-finding support in the detector (covered by the secrets firewall instead); not measured here.",
    },
    cpu: { status: "NOT_MEASURED", reason: resources.methodology.cpu.reason },
    backendVlmLatency: { status: "NOT_MEASURED", reason: "no live provider key in this environment; fake-provider timing would be meaningless" },
    weightedScore: {
      weights: { visualContextAccuracy: "25%", piiF1: "20%", redactionPrecision: "20%", clientResources: "20%", e2eLatency: "15%" },
      normalization: [
        "accuracy/precision/recall/F1 enter as 0..1 (higher is better).",
        "resourceScore = max(0, 1 - peakRssDeltaMb/500): 500 MB is a stated generous client bound, not a product claim.",
        "latencyScore = max(0, 1 - e2eMedianMs/30000): 30 s is the stated task budget matching provider timeouts.",
        "Formulas are budget-based and documented here; they were not tuned to maximize the score.",
      ],
      inputs: weightedInputs,
      value: weightedScore,
      display: weightedScore === null ? "INSUFFICIENT DATA" : `${(Math.round(weightedScore * 1000) / 10).toFixed(1)}%`,
      status: weightedScore === null ? "INSUFFICIENT DATA" : "MEASURED",
    },
    baseline: "No historical baseline available.",
  };

  writeFileSync(resolve(REPORTS, "results.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(resolve(ROOT, "docs/METRICS.md"), render(results));
  console.log(`results.json + docs/METRICS.md written (${results.generatedAt}, commit ${results.commit})`);
  if (weightedScore !== null) console.log(`weighted score: ${results.weightedScore.display}`);
}

function stageRow(name, s) {
  if (!s || typeof s.median !== "number") return `| ${name} | INSUFFICIENT DATA | — | — | — | — |`;
  return `| ${name} | ${s.n} | ${ms(s.median)} | ${ms(s.p95)} | ${ms(s.max)} | ${s.failures ?? 0} |`;
}

function render(r) {
  const stages = r.latency.stages;
  const perCat = Object.entries(r.pii.perCategory)
    .map(([t, m]) => `| ${t} | ${m.tp}/${m.fp}/${m.fn} | ${pct01(m.precision)} | ${pct01(m.recall)} | ${m.samples} |`)
    .join("\n");
  const failures =
    r.pii.failures.length === 0 && r.visionAccuracy.value === 1 && r.redaction.overRedactedOps === 0
      ? "None. Zero failed fixtures across vision grounding, PII and redaction; zero over-redacted ops."
      : JSON.stringify(r.pii.failures.slice(0, 20));
  const ambig = r.pii.ambiguousTrackedSeparately;

  return `# TrusTech Metrics

> Generated from actual benchmark execution. Do not hand-edit values below:
> re-run \`npm run metrics\`. Timestamp: ${r.generatedAt} · commit: ${r.commit}.

## 1. Executive summary

| Metric | Result | Weight | Notes |
| --- | ---: | ---: | --- |
| Visual-context accuracy | ${r.visionAccuracy.display} | 25% | Measured, ${r.visionAccuracy.fixtures} fixtures |
| PII precision | ${r.pii.precisionDisplay} | 20% (as F1 ${pct01(r.pii.f1)}) | Measured, ${r.pii.clearItems} texts |
| PII recall | ${r.pii.recallDisplay} | — (folded into F1) | Measured |
| Redaction precision | ${r.redaction.precisionDisplay} | 20% | Measured, ${r.redaction.gtBoxes} boxes |
| Client resources | peak RSS Δ ${r.resources.memory.peakDeltaMb} MB | 20% (budget-normalized) | Measured; CPU NOT_MEASURED |
| Median E2E latency | ${ms(stages?.e2e?.median)} | 15% (budget-normalized) | Measured, n=${stages?.e2e?.n ?? 0} |
| **Weighted score** | **${r.weightedScore.display}** | 100% | ${r.weightedScore.status} |

## 2. Environment

- Node ${r.environment.node} · ${r.environment.platform}
- Commit ${r.commit} · ${r.generatedAt}

## 3. Datasets

- Vision grounding: \`tests/metrics/fixtures/vision.json\` (15 fixtures: navbar, form, search, select, video, modal, cards, list, disabled, partial-edge, nested, duplicates, overlay, stale, DPR-2).
- PII: \`tests/metrics/fixtures/pii.json\` v1 (${r.pii.clearItems} clear + ${ambig} ambiguous; generator \`generate-pii.mjs\`).
- Redaction: \`tests/metrics/fixtures/redaction.json\` v1 (7 scenes).

## 4. Methodology

- Vision accuracy = proposals resolved to the intended element (or documented failure code) / all proposals. Real-model line is informational (no GT boxes exist): known-target presence on sample-cats.png.
- PII: same type + char-span IoU ≥ 0.5. Headline over CLEAR items; AMBIGUOUS shapes (invalid-checksum Aadhaar, dotless UPI-shaped handle) measured separately by engine-design intent.
- Redaction: recall = GT boxes ≥95% covered / all; precision = ops covering ≥95% of ≥1 GT box / all ops; over-redaction = op area > 3× covered GT union.
- Latency: ${r.latency.definition.warmup}; high-resolution timers; E2E = ${r.latency.definition.e2e}.
- Resources: in-process RSS sampling (GC caveat applies); payload bytes by encoding; request counts from mock transports.

## 5. Results

### Vision grounding: ${r.visionAccuracy.display} (${r.visionAccuracy.passed}/${r.visionAccuracy.fixtures}), Wilson 95% [${pct01(r.visionAccuracy.wilson95[0])}, ${pct01(r.visionAccuracy.wilson95[1])}]

Model line: ${r.visionModel.catsDetected}/${r.visionModel.knownTargets} cats, ${r.visionModel.detections} detections, inference ${r.visionModel.inferenceMs} ms (${r.visionModel.status}).

### PII: precision ${r.pii.precisionDisplay}, recall ${r.pii.recallDisplay}, F1 ${pct01(r.pii.f1)} (TP ${r.pii.tp} / FP ${r.pii.fp} / FN ${r.pii.fn})

| Category | TP/FP/FN | Precision | Recall | Samples |
| --- | --- | ---: | ---: | ---: |
${perCat}

Ambiguous shapes tracked separately (${ambig} items, all emit weak findings by design — see fragment-pii-ambiguous.json).

### Redaction: precision ${r.redaction.precisionDisplay}, recall ${r.redaction.recallDisplay} (${r.redaction.coveredBoxes ?? r.redaction.gtBoxes}/${r.redaction.gtBoxes} boxes, ${r.redaction.appliedOps} ops, ${r.redaction.overRedactedOps} over-redacted)

## 6. Failure analysis

${failures}

## 7. Latency (measured, failures included in counts)

| Stage | n | Median | p95 | Max | Failures |
| --- | ---: | ---: | ---: | ---: | ---: |
${stageRow("vision/inference", stages?.visionInference)}
${stageRow("sanitization", stages?.sanitization)}
${stageRow("transmission", stages?.transmission)}
${stageRow("grounding", stages?.grounding)}
${stageRow("execution", stages?.execution)}
${stageRow("verification", stages?.verification)}
${stageRow("end-to-end", stages?.e2e)}

## 8. Resources (measured)

- RSS: baseline ${r.resources.memory.baselineRssMb} MB, peak ${r.resources.memory.peakRssMb} MB, Δ ${r.resources.memory.peakDeltaMb} MB.
- CPU: ${r.cpu.status} — ${r.cpu.reason}.
- Sanitized PNG payloads: 640×480 scenes range ${(function () { const b = r.resources.payloads.sanitizedPngBytes.map((x) => x.bytes); return Math.min(...b) + "–" + Math.max(...b); })()} bytes.
- Requests: ${r.resources.requests.sanitizedTransmissionsObserved} mock transmissions observed in this run; blocking paths assert 0 requests (AT-03/AT-05).

## 9. Weighted score: ${r.weightedScore.display}

${r.weightedScore.normalization.map((l) => `- ${l}`).join("\n")}

## 10. Limitations

- Model box-level accuracy: INSUFFICIENT DATA (no GT boxes for photos).
- API-key/token PII findings: INSUFFICIENT DATA (no detector support; secrets firewall covers blocking, unmeasured here).
- Backend VLM latency: NOT_MEASURED (no live provider key).
- CPU: NOT_MEASURED. RSS is GC-sensitive; treat deltas as approximate.
- Latency/VLM behavior varies by machine, model and network; this report is one environment snapshot.
- Candidate regression floors (not enforced): vision accuracy ≥ 90%, PII recall = 100% on the clear corpus, redaction precision = 100%, e2e p95 < 5 s. These are proposals, not gates.

## 11. Reproduction

\`\`\`
npm run metrics
\`\`\`

Runs \`vitest run tests/metrics\`, writes \`tests/metrics/reports/fragment-*.json\`, then generates \`results.json\` + this file. Re-running changes values only when measurements change (accuracy fixtures are deterministic; latencies naturally vary). Fragments are per-suite files so parallel workers never race. Full product suite stays separate: \`npm test\`.
`;
}

main();
