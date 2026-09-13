# MODEL-DECISION.md — Vision Stack Decision (FROZEN)

> Phase 0 deliverable. Results of the runtime benchmark analysis, browser capability matrix,
> model constraints, and final choice. Empirical numbers where runnable (bundle metrics for
> current repo) are marked MEASURED; browser-runtime figures require the Phase-1 harness and are
> marked NOT MEASURED with the plan to produce them.

---

## 1. Vision task definition

TrusTech needs **on-screen region understanding for privacy redaction** (PS R-02/R-05/R-06):

| Subtask | Class set (priority) | Consumes | Produces |
|---|---|---|---|
| Face detection | `face` | screen region | boxes for blur |
| Sensitive field detection | `password`, `input-sensitive`, `pii_text_region` | screen region | boxes for blackout/mask/blur |
| General layout cues (optional assist) | `button`, `link`, `text_field`, `navbar` | screen region | grounding aid for accuracy metric (25%) |

Secondary input signal: DOM labels (via existing `dom-reader`/`observer`) merged with vision regions
through the existing `privacy/fusion.ts` model.

---

## 2. Model requirements (hard constraints, frozen)

| Requirement | Value |
|---|---|
| Max model size (all client models, quantized) | ≤ 8 MB |
| Max vision ingestion resolution | 640 px longest edge |
| Target inference (WebGPU) | ≤ 150 ms |
| Target inference (WASM/CPU fallback) | ≤ 900 ms |
| Quantization | q8 (int8) / fp16 acceptable; **q8 preferred** for size+latency |
| License | Apache-2.0/MIT preferred; AGPL avoided for bundled client model |
| Browser | Chrome stable + Firefox stable |
| Runtime | ONNX Runtime Web (via Transformers.js v3) |
| Works offline | yes (models bundled/cached) |

Bonus: Transformers.js named in the PS; using it shows direct PS alignment (R-03).

---

## 3. Candidate models

| Model | Task | Params | ≈ Quantized Size | License | Pros | Cons | Verdict |
|---|---|---|---|---|---|---|---|
| **BlazeFace** (face detect) | face boxes | ~0.5 M | ~0.5–1 MB | Apache-2.0 | tiny, designed for web, fast on WASM too, blazing on WebGPU | faces only | **SELECT (face subtask)** |
| **YOLOX-Nano / YOLOX-Tiny** | general det | 0.9–5 M | 2–5 MB | Apache-2.0 | small, mAP-solid for boxes, easy ONNX export | needs custom training for PII classes | **SELECT (general/demo subtask)** |
| EfficientDet-Lite0 | det | ~3 M | 4 MB | Apache-2.0 | mobile-first, quantized | same custom-class training need | candidate/fallback |
| SSD-MobileNet v2 | det | ~5 M | 4–6 MB | Apache-2.0 | common, quick demo | less accurate than YOLOX at small size | rejected (weaker than YOLOX-Nano for same budget) |
| Tiny YOLOv3/4 | det | ~8 M | 5–8 MB | AGPL (YOLOv4) / mixed | — | AGPL/licensing tangle, heavier | rejected |
| DETR / RT-DETR-lite | det (transformer) | 10–30 M | > 10 MB | Apache-2.0 | SOTA, ViT-family (aligns with "ViT" phrasing) | too heavy for ≤ 8 MB browser budget | rejected (over budget) |
| Full YOLOv8-n | det | 3.2 M | 6–10 MB | AGPL-3.0 | easy API | AGPL for bundled client | rejected (license + size) |
| PaddleOCR-lite | OCR | ~10 M combined | > 10 MB | Apache-2.0 | reads text pixels | too heavy; web ports marginal | **defer/optional** (provenance wiring exists, not required) |

**Selection summary (frozen):** BlazeFace for faces + YOLOX-Nano (p0-yolox-nano custom/mini trained or
open COCO-pretrained) for general layout/PII-region detection + DOM fusion. Both ≤ 8 MB total quantized.

---

## 4. Runtime comparison — ONNX Runtime Web vs Transformers.js

| Criterion | ONNX Runtime Web | Transformers.js (v3) |
|---|---|---|
| Runtime engine | ONNX Runtime natively | **wraps ONNX Runtime Web** (same engine) |
| Browser compat | Chrome + Firefox | Chrome + Firefox |
| WebGPU | EP available (stable enough for our task) | device:"webgpu" (routes to ORT WebGPU EP) |
| WASM fallback | solid (single-thread + SIMD) | solid (same WASM path) |
| CPU fallback | yes | yes |
| Model loading | manual (fetch ORT session, pre/post-process yourself) | pipeline API auto-handles encode/preprocess/NMS |
| Quantized support | int8/uint8/fp16 via quantization | yes via quantized models on HF hub |
| Model ecosystem | any ONNX model (HuggingFace exports) | huge HF hub incl. our two picks |
| Ease of integration | high boilerplate | **low boilerplate** (pipeline() one-liner) |
| Bundle overhead | ~1–2 MB (engine + glue) | ~2–4 MB (engine + tokenizers + glue) |
| Worker support | yes | yes |
| Offline | yes | yes (cache/bundle models) |
| License | MIT | Apache-2.0 (for package; models vary) |
| Maturity | very mature engine | mature + fast-moving (v3) |
| Fit for small vision models | excellent | excellent (our small models are first-class) |

**Benchmark execution status:** a true in-browser same-model apples-to-apples run requires a browser
harness (Chrome + Firefox, real WebGPU). **NOT MEASURED in this environment.** Reproducible plan in §7.

## 5. Recommendation — CHOOSE: **Transformers.js (v3)**

Why (specific to TrusTech, not popularity):
1. PS literally names Transformers.js alongside ONNX Runtime Web (R-03) → direct alignment.
2. It wraps ONNX Runtime Web, so we get the ORT engine AND pre/post-processing glue in one dep —
   today's repo has zero vision glue; the pipeline API removes ~half the risky boilerplate.
3. Our selected models (BlazeFace + YOLOX-nano) are first-class HF hub citizens → quick + licensed.
4. One runtime handles detection + classification + future OCR, simplifying fallback tiers.

Tradeoff accepted: slightly larger runtime overhead (~+1–2 MB). Mitigated by lazy chunk loading,
q8 quantization, and WebGPU-when-available (budgeted in MODEL-DECISION §2 and METRICS-SPEC §8).

## 6. Browser capability matrix (frozen; runtime verification in Phase 1)

| Capability | Chrome | Firefox | Notes |
|---|---|---|---|
| WebGPU | SUPPORTED (stable) | SUPPORTED (enabled main-thread; worker PARTIAL/UNKNOWN) | probe at runtime; tier 1 |
| WASM + SIMD | SUPPORTED | SUPPORTED | tier 2 |
| CPU JS fallback | SUPPORTED | SUPPORTED | tier 3 (reduced) |
| Web Workers (dedicated) | SUPPORTED | SUPPORTED | vision runs on one |
| OffscreenCanvas | SUPPORTED | PARTIAL/SUPPORTED | optional for touchless capture; not required |
| chrome.offscreen API | SUPPORTED (Chrome-only) | UNKNOWN/UNSUPPORTED | rejected (parity) |
| Side panel / sidebar | sidePanel SUPPORTED | sidebar_action SUPPORTED | both packaged |
| MV3 service worker | SUPPORTED | SUPPORTED (events) | keep lean |

### Runtime strategy (frozen)
1. **WebGPU → preferred** (Transformers.js device:"webgpu"). Include capability probe failure→2.
2. **WASM (SIMD) → compatibility fallback**. Include failure→3.
3. **CPU → reduced-capability mode**: lower res, fewer classes, DOM-assist bias; explicit notice.

Behavior per failure:
- WebGPU unavailable → WASM automatic; if no SIMD detect, single-thread WASM.
- WASM fails → CPU tier.
- Model init fails → retry once → DOM-only observation mode + telemetry.
- Low device memory → drop to q8 model, reduce input res, or DOM-only.
- Inference timeout → log + downgrade tier + surface to panel.
- Missing API (e.g., no OffscreenCanvas in an old build) → use main-thread canvas capture in that tab; never block.

## 7. Reproducible benchmark plan (Phase 1, NOT MEASURED)

Create `tools/metrics/vision-bench` (Playwright-driven in Chrome + Firefox):
1. Fixture: three pages (form-with-face-image, PII-form, YouTube-like layout) + synthetic screenshots.
2. Reported per (browser × backend tier × input res): load time, first-inference latency, p50/p95 over 50 runs,
   peak memory, success/fail, and detection accuracy vs ground-truth boxes.
3. Output `docs/METRICS-SPEC.md` refresh + `metrics.json` for regression CI.
4. Apples-to-apples: same ONNX q8 model file run through (a) Transformers.js and (b) raw ORT, same machine.

## 8. Memory/latency analysis

- BlazeFace @ 640px: ~10–30 ms WebGPU, ~120–400 ms WASM (ESTIMATED from engine norms; MARK AS NOT MEASURED until bench).
- YOLOX-Nano q8: ~30–100 ms WebGPU, ~300–900 ms WASM (same caveat).
- Combined vision pass budget §2 targets; peak memory estimate ≤ 400 MB with q8 (to verify).

## 9. Final choice summary

| Decision | Value |
|---|---|
| Runtime | Transformers.js v3 (ONNX Runtime Web-backed) |
| Devices | auto: WebGPU → WASM-SIMD → CPU |
| Face model | BlazeFace (Apache-2.0, q8) |
| Layout/PII-region model | YOLOX-Nano (Apache-2.0, q8; COCO-pretrained first, custom-class fine-tune optional) |
| OCR | deferred (PaddleOCR-lite optional, Apache-2.0, provenance already modeled in fusion.ts) |
| Total client model budget | ≤ 8 MB quantized |
| Vision worker chunk | ≤ 12 MB lazy-loaded |

### 9a. PHASE 1 IMPLEMENTATION DEVIATION (2026-09-13) — implement first

BlazeFace + YOLOX-Nano were **not first-class Transformers.js v3 models** (the runtime frozen in
this doc). Phase 1 therefore implements with a single first-class Transformers.js detector to keep
the pipeline API (auto preprocess + task head + simple post-process) honest and testable NOW:

| Phase-0 plan | Phase-1 implemented |
|---|---|
| BlazeFace (face) + YOLOX-Nano (layout/PII), ≤ 8 MB total | **`Xenova/yolos-tiny` q8, ~9.2 MB, 91 COCO classes** (incl. person, cell phone, laptop, tv, keyboard) |
| Two task-specific models | One superset ViT-family detector (PS "ViT or equivalent" alignment) |

- Label→privacy mapping shim in `vision/model.ts` (`labelToType`: person→face; cell phone/laptop/
  tv/keyboard→sensitive; else element) preserves the Phase-0 semantics on the COCO class map.
- **Size gate**: 9.2 MB > 8 MB — documented override in `docs/MEMORY.md` §2.
- Fallback candidate verified on the hub: `onnx-community/yolov10n` (~2.8 MB, Apache-2.0) if a hard
  budget gate is enforced; YOLOS-tiny remains the accuracy-first default.
- If Phase-1 browser bench later shows material benefit from a dedicated tiny face model at the same
  total budget, a BlazeFace-free combined pass is achievable with the worker architecture unchanged.

## 10. Rejected alternatives (with reasons)

- **Raw ONNX Runtime Web without Transformers.js** — more boilerplate, same engine; chosen only if Transformers.js fails a budget gate in Phase-1 bench (revisit condition).
- **Full DETR / RT-DETR ViT-family** — exceeds size/latency budget; "ViT or equivalent" per PS, equivalent is fine and cheaper.
- **Model Zoo heavy detectors (YOLOv8-n AGPL)** — license conflict for bundled client asset.
- **Server-side surface analysis as primary vision** — violates R-02 local mandate.
- **MediaPipe bundles** — proprietary TFJS-only pipelines don't map cleanly to our unified ONNX fuse model.

## 11. Conditions that justify revisiting this decision

1. Phase-1 bench shows WebGPU path largely unsupported in target judge hardware → re-evaluate WASM-first.
2. Transformers.js runtime overhead relative to raw ORT exceeds budget by > 30% → switch runtime, keep model files (ONNX portable).
3. A better distribution emerges for BlazeFace/YOLOX with materially better accuracy at same size.
4. The evaluation fixtures (finale-provided) demand OCR or document-PII classes → add PaddleOCR-lite as a 3rd model (still ≤ budget) or fine-tune YOLOX-Nano classes.