# TrusTech Performance (Phase 9)

> All values MEASURED from `npm run build` / `npm run performance` on this
> machine (darwin-arm64, node v26.0.0). Frozen BEFORE baseline:
> `tests/performance/baseline.json`. Budgets: `performance-budget.json`.
> Reproduce: `npm run performance`. Accuracy source: `npm run metrics`.

## 1. Baseline (BEFORE)

| Artifact | Bytes | Gzip |
| --- | ---: | ---: |
| `dist/js/panel.js` | 876,677 | 244,607 |
| `dist/js/background.js` | 11,555 | 3,630 |
| `dist/js/content.js` | 51,802 | 17,869 |
| `dist/assets/vision.worker.js` | 6,894 | 3,164 |
| `dist/assets/transformers.web.js` (lazy) | 899,013 | 233,168 |
| Model `model_quantized.onnx` | 9,661,148 | — |

Latency/memory baseline: Phase 8 metrics 14:49Z (e2e med 0.67 ms, RSS Δ 80.44 MB).

## 2. Audit — why panel.js was ~877 KB

`Panel → RobotStage → AgentBot → agentAvatarScene/starfield/glowTexture →
import * as THREE`: the full three.js runtime loaded eagerly with the panel
(proven: `WebGLRenderer` × 5 inside panel.js). The vision/model runtime was
already separated (0 × `onnxruntime`/`InferenceSession` in panel.js; worker
chunk + dynamic `import("@huggingface/transformers")` + offline quantized
model). lucide-react tree-shakes (unused icon names absent from bundle).

## 3. Changes

1. **3D robot lazy-load** (`extension/src/ui/components/Panel.tsx`):
   `RobotStage` via `React.lazy` + `Suspense` skeleton fallback preserving the
   hero layout (no shift, same `onChamberReady` contract). three.js now ships
   as lazy `dist/js/RobotStage-<hash>.js`, fetched after first paint.
2. **No other production changes.** Worker, model, capture, sanitization paths
   were already optimal (single reusable worker, shared init promise,
   transferable buffers, downscale helper, quantized model) — left untouched
   per "keep only verified improvements".
3. **Guards added**: `performance-budget.json`,
   `tests/performance/bundle-size.test.ts` (budgets + chunk-hygiene asserts),
   `tools/measure-bundles.mjs`, `npm run performance` script,
   `tests/performance/downscale-eval.test.ts`,
   `tests/performance/memory-stability.test.ts`.

## 4. Architecture before / after

BEFORE: Panel { UI + three.js + agent } · Background · Content (IIFE) ·
Vision worker { engine + lazy transformers + cached offline model }.
AFTER: identical, except Panel = lightweight UI core and the 3D companion is
a lazy chunk (`panel → dynamic import → RobotStage chunk → three`).
Message contracts (panel↔worker, Phase 6/7 agent pipeline, sanitize-before-
transmit ordering) unchanged — no security/safety bypass.

## 5. Bundle results (AFTER, measured)

| Artifact | Before | After | Change |
| --- | ---: | ---: | ---: |
| panel.js | 876,677 | **377,466** | **−499,211 (−57%)** |
| RobotStage chunk (lazy) | — | 500,091 | new, post-paint |
| background.js | 11,555 | 11,555 | 0 |
| content.js | 51,802 | 51,802 | 0 |
| vision worker | 6,894 | 6,894 | 0 |
| transformers.web (lazy) | 899,013 | 899,013 | 0 (already lazy) |
| Total initial panel JS | 876,677 | 377,466 | −57% initial cost |

`BUNDLES: PASS` — panel within 450 KB budget, three.js absent from panel.js.

## 6. Performance results

Downscale eval (real model, sample-cats.png 622×412, 2 reps each):

| maxEdge | Raster | Transfer bytes | Prep ms | Infer ms | Cats |
| ---: | --- | ---: | ---: | ---: | ---: |
| 320 | 320×212 | 271,360 | ~47 | ~1390 | 2/2 |
| 480 | 480×318 | 610,560 | ~49–69 | ~1385 | 2/2 |
| 1333 (native) | 622×412 | 1,025,056 | ~73–108 | ~1350 | 2/2 |

Finding: inference time is resolution-independent (model resizes internally);
downscaling saves transfer bytes (up to 3.8×) + preprocess time with zero
detection change on this probe. E2E med 0.74 ms (Phase 8 rerun 14:56Z).

## 7. Resource results

Repeated inference (6 runs, post-warmup): RSS flat, steady-state growth
4.7 MB isolated / 67 MB full-suite worker — no unbounded growth, no session
duplication. One-time arena alloc +~500 MB on first model run (node
onnxruntime; browser WASM will differ). Absolute node RSS ~1.3 GB is a test-
harness figure, not a client claim.

## 8. Accuracy regression (Phase 8 rerun, MUST-PASS)

Vision 100% (15/15) · PII P/R 100%/100% · Redaction P 100% ·
weighted 96.7% (was 96.8%; delta is RSS/latency noise, accuracies identical).
Full suite: **794/794 passed** (790 existing + 4 new perf). Backend: 141 passed.

## 9. CI

No workflows exist in this repo, so the gates run in the test suite itself
(`npm test` includes `tests/performance/`): budget asserts + chunk-hygiene
asserts fail the run on violation. `npm run performance` = build + measure +
perf tests with PASS/FAIL exit status. Budgets = measured-after + ~20–40%
headroom; raise only with documented reason.

## 10. Limitations

- Browser paint-time / WebGPU / extension memory: NOT_MEASURED (no browser harness here).
- Quantization: already-quantized model ships; further quantization rejected without accuracy evidence.
- Worker INFER has no explicit queue; single-flight issuance by the planner observed — no contention evidence, so no change made.
- Node RSS figures are harness-specific and GC-sensitive.
- content.js grew 25→51 KB since Phase 0 (feature growth, self-contained IIFE by MV3 necessity) — tracked by its 70 KB budget, not yet optimized.
