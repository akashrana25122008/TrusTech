# ARCHITECTURE.md — TrusTech Frozen Architecture (SIH26171)

> Phase 0 deliverable. This freezes the target architecture for the NEXT implementation phases.
> It is a target spec: today's repo (audit baseline) has the browser/agent/privacy/backend layers
> but **NO vision layer** (confirmed). This file defines where vision slots in without disturbing
> the proven agent/privacy/backend design.

---

## 1. Frozen architecture (target)

```
                 ┌──────────────────────────────────────────────────────────────┐
                 │  EXTENSION (Chrome MV3 + Firefox)                            │
                 │                                                              │
 USER ──► Side Panel (React: TaskInput, Timeline, Verification, 3D robot)       │
                 │                                                              │
                 │  AgentController  (existing, unchanged contract)             │
                 │   observe → plan → risk-gate → execute → verify → complete   │
                 │        ▲                            │                        │
                 │        │   ObservationSnapshot     │  AgentAction            │
                 │   ┌────┴─────────┐           ┌─────▼───────────┐             │
                 │   │ VISION LAYER │           │ CONTENT SCRIPT  │             │
                 │   │ (NEW, worker)│◄──screenshot─┴──► executor.ts │             │
                 │   │ detect+redact│            └─────┬───────────┘             │
                 │   └────┬─────────┘                  │ DOM calls               │
                 │        │ sanitized image + manifest │                         │
                 │   ┌────▼────────────────────────────▼─────────────────────┐   │
                 │   │ PRIVACY BOUNDARY (existing transmission gate,         │   │
                 │   │  extended: visual redactions BEFORE egress)           │   │
                 │   └────┬──────────────────────────────────────────────────┘   │
                 └────────┼────────────────HTTPS (only anonymized bytes)────────┘
                          ▼
              ┌───────────────────────────────┐
              │  SERVER (FastAPI, existing)    │
              │  NEW: /vision_step accepts     │
              │  sanitized image + redaction   │
              │  manifest → LLM/VLM → typed    │
              │  UI actions (reuse TOOL_CATALOG│
              │  + response-parser contract)   │
              └───────────────────────────────┘
```

Processing is deliberately split: **LOCAL = deterministic browser actions, DOM observation, vision
inference, redaction, PII detection; REMOTE = LLM/VLM reasoning only; HYBRID = the redaction-aware
sanitized round-trip.** Sensitive page data never crosses the privacy boundary.

---

## 2. Component responsibilities

| Component | Responsibility | Input | Output | Runtime | Dependencies | Fallback | Failure handling |
|---|---|---|---|---|---|---|---|
| Side Panel (UI) | command intake, status, verification | user text | task intent | browser | agent role | — | error banner |
| AgentController | agent loop, risk gate, pause/resume, completion | intent + observation | actions | background/SW | planner, policy, verifier | deterministic plan | pause (never hard-crash), resume |
| Vision Layer (NEW) | screen capture → local inference → redaction regions | screenshot/frame | structured scene + redaction manifest | **dedicated Web Worker** (or offscreen doc) | ONNX runtime (Transformers.js v3), model files | WASM→CPU tier; reduced mode | degrade to DOM-only observation + explicit notice |
| Content Script | trusted DOM executor + capture API | AgentAction | action effect | page | executor, observer | element-path retry | per-step error surfaced |
| Privacy Boundary | sanitize text + visual before egress | raw contexts | sanitized payloads | content/background | detector, image.ts | fail-closed (block) | block + log + notify |
| LLM gateway (server) | reasoning over sanitized context | sanitized context | typed actions | server | provider chain | Groq→Gemini→OpenRouter | labeled fallback, timeout |
| Storage/State | memory store, tab state, telemetry | events | persisted state | SW/indexedDB | — | in-memory only | restart-safe tab rebuild |

---

## 3. Data flow (vision + agent, end to end)

1. User goals `TaskInput` → `AgentController`.
2. `observe`: Observer/dom-reader produce `ObservationSnapshot`; **NEW** Vision Layer concurrently
   produces a screen-region map (faces, password fields, PII boxes).
3. Fusion: DOM metadata + vision regions merged into one structured snapshot (see `privacy/fusion.ts`
   data model — DOM + `"ocr"`-style sources already foreshadowed).
4. `plan`: deterministic planner → action sequence (existing) or LLM planner via server.
5. `risk-gate`: `safety-policy.ts` + `drift.ts` + `trust.ts` (existing) decide execute/pause/ask.
6. `execute`: content executor performs action in page (existing contract).
7. `verify`: verifier/`completion-detector.ts` compares expected vs actual outcome; loops.
8. If server reasoning is needed: Vision Layer produces sanitized screen + redaction manifest →
   transmission gate (privacy boundary) → `POST /vision_step` → typed actions → execute locally.

---

## 4. Runtime boundaries

- **Worker boundary:** vision runs in a dedicated Web Worker spawned by the panel (works in Chrome + Firefox;
  avoids MV3 SW heft and avoids offscreen-doc API which Firefox lacks).
- **Classic script boundary:** content.js is a classic IIFE (verified build) and must NOT import ESM →
  vision glue talks to it over message channel with JSON payloads only.
- **Privacy boundary:** the only egress surface is the transmission gate; everything else is local.

---

## 5. Local vs remote processing (explicit)

| Workload | Location | Rationale |
|---|---|---|
| Deterministic browser actions | LOCAL | privacy + latency |
| DOM observation / indexing | LOCAL | privacy + latency |
| **Vision inference** | **LOCAL (mandatory per PS)** | PS R-02/03 |
| PII detection & redaction | LOCAL | PS R-05/06 |
| LLM/VLM reasoning | REMOTE (server) | PS R-08/09 |
| Model loading | LOCAL (bundled/cached artifact) | offline + privacy |
| Telemetry (non-sensitive) | LOCAL first, aggregate only | — |

---

## 6. Browser execution strategy (frozen)

Capability detection at startup (Chrome + Firefox). See BROWSER-CAPABILITY and MODEL-DECISION.md.

Runtime tier map (auto-selected):
1. **WebGPU** — preferred inference path (PS names it).
2. **WASM + SIMD** — compatibility fallback (Firefox older GPUs, headless).
3. **CPU (pure JS fallback)** — reduced-capability mode: lower resolution / fewer frames / DOM-only assist.

Failure ladder (no silent degradation):
- WebGPU unavailable → try WASM; else CPU; else **DOM-only observation mode** with a visible "vision disabled" notice.
- Model init fails → retry once → DOM-only mode.
- Inference timeout (budget exceeded) → emit timing telemetry + fallback tier.

---

## 7. WebGPU / WASM / CPU fallback (matrix in MODEL-DECISION.md §6)

Chrome: WebGPU SUPPORTED (stable), WASM SIMD SUPPORTED. Firefox: WebGPU SUPPORTED (main-thread webgpu;
worker WebGPU PARTIAL/UNKNOWN), WASM SUPPORTED. Capability probe must run in-browser; final matrix
recorded as measurement in Phase 1.

---

## 8. Agent execution flow (unchanged, validated)

Existing loop is frozen as-is: `controller.ts` `while(true)` + terminal/paused states +
`waitWhilePaused` + `checkCompletion` + `evaluateActionSafety`. Vision is an *additional observation
input*, not a replace of the loop.

## 9. Vision flow (frozen as target)

capture → downscale (≤ 640 px) → tensor (fp16/uint8) → inference (WebGPU/WASM/CPU) →
post-process (NMS) → region map (class, box, confidence) → fusion with DOM → redaction manifest →
[sanitize → transmit] or [local action].

### 9a. Phase 1 implementation status (deviations from 9/10 are documented)

- **Implemented** in `extension/src/vision/` as specified: dedicated module Worker spawned by the
  panel (`VisionWorkerClient` ↔ `vision.worker.ts` ↔ `VisionEngine`), capture via
  `chrome.tabs.captureVisibleTab`, offline Transformers.js v3 runtime, exact model processor,
  softmax→threshold→top-k→NMS→image-relative xywh, per-stage latency, zero-copy raster transfer,
  panel `VisionInspector` UI with live detection overlay + metrics. Evidence: AT-01 real inference +
  502-test suite (see `docs/MEMORY.md`).
- **Model deviation (Phase 1)**: BlazeFace + YOLOX-Nano were not first-class Transformers.js v3
  models; implementation uses **`Xenova/yolos-tiny` q8 (~9.2 MB, Apache-2.0, 91 COCO classes,
  ViT-family)**. One superset model replaces two — recorded override vs the Phase-0 ≤ 8 MB budget
  in `docs/MEMORY.md` §2, with `onnx-community/yolov10n` (~2.8 MB) as the fallback if a hard gate
  is enforced.
- **Vite deviation (Phase 1)**: module-worker + dynamic import required `worker.format = "es"` in
  `vite.config.ts`; without it the build fails (`Invalid value "iife"`). Verified result: vision
  worker shell (6.8 KB) + lazy `transformers.web` (~899 KB) stay OUT of `panel.js`.
- **Runtime deviation (Phase 1)**: `env.backends.onnx.wasm.wasmPaths` must be overridden to the
  bundled `wasm/` dir (default is jsdelivr CDN) or the "offline" worker hits the network on first
  inference. `env.allowRemoteModels=false`, `allowLocalModels=true`, `localModelPath` → bundled
  `models/`.

## 10. Error handling (frozen)

- Never block the SW: vision worker failures are isolated; panel shows degraded state.
- All egress is fail-closed (existing image.ts gate philosophy preserved).
- Provider failures → labeled fallback chain (evidence: tests for 429/503 handling pass).
- Page-level action failures → pause-with-reason (existing controller contract).

## 11. Privacy/security boundaries (frozen)

- API keys only in backend env (`repr=False`, `.env.example` excludes real values) — CONFIRMED.
- Backend bearer token optional (empty = open local demo) — documented.
- Bearer tokens: CORS allow-list localhost; no credentials cookies.
- Vision manifests may contain **positions only, never content** outside the redaction-scheme wire format.
- No screenshots stored server-side.

## 12. Performance constraints (frozen targets; full in METRICS-SPEC §8)

- SW ≤ 40 KB; content ≤ 60 KB; panel ≤ 700 KB; vision chunk ≤ 12 MB lazy.
- Vision inference ≤ 150 ms (WebGPU), ≤ 900 ms (WASM).
- E2E step ≤ 1.5 s local / ≤ 4 s server path.

## 13. Architecture decisions (ADR summary — full register in separate ADR doc)

| ID | Decision |
|---|---|
| ADR-01 | Vision runtime = Transformers.js v3 (wraps ONNX Runtime Web) |
| ADR-02 | Vision runs in dedicated Web Worker (not SW, not offscreen-doc) |
| ADR-03 | Browser backend priority WebGPU → WASM-SIMD → CPU |
| ADR-04 | Vision fused with DOM into one snapshot (fusion.ts model) |
| ADR-05 | Server `vision_step` reuses existing TOOL_CATALOG + response-parser contracts |
| ADR-06 | Fail-closed egress preserved; vision only adds sanitized senders |
| ADR-07 | No new server-side storage of visual data |

## 14. Explicitly rejected alternatives

- **Server-side vision as primary** — violates PS local-vision mandate (R-02).
- **Offscreen-Document for vision** — Chrome-only API; breaks Firefox parity (R-11).
- **Vision in the MV3 service worker** — worker lifetime + memory blow the "light-weight" budget.
- **No vision (current repo)** — fails R-02/03/06/16 (the majority of score).
- **Heavy/full-frame LLM at client** — latency + resource impossible locally for a light-weight agent.