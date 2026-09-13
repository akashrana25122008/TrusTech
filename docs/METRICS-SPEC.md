# METRICS-SPEC — TrusTech Baseline & Budgets (FROZEN)

> Phase 0 deliverable. Baseline measured on commit `3de7562` + working tree, macOS (darwin),
> node v26.0.0 / npm 11.12.1. All latency/memory figures that could not be executed here are
> explicitly stamped **NOT MEASURED** with the instrumentation required.

---

## 1. Measurement methodology

- **Bundle:** `du`/`stat -f%z` on `dist/` after a cold `npm run build`. Deterministic (no runtime).
- **Latency:** performance.now() marks at pipeline stages, captured by a metrics harness (to be built).
- **Memory:** `performance.memory` (Chrome), `/proc`-style RSS unavailable in-browser; use
  `chrome.processes` / DevTools memory timeline / `performance.measureUserAgentSpecificMemory()` (Chrome).
- **Agent latency:** synthetic agent loop drives a scripted page; per-stage timings recorded via EventBus.
- **Labels:** MEASURED = run here; ESTIMATED = derived from code/data with stated assumptions; NOT MEASURED = requires a browser harness.

---

## 2. Bundle metrics — MEASURED (2026-09-13, `dist/`)

Phase 1 executed the frozen vision foundation (see `docs/MEMORY.md`). Refreshed measurements below.

| Asset | Size (bytes) | Notes |
|---|---|---|
| `dist/js/panel.js` | 830,215 (810 KB) | Three.js robot bundled; includes React. **dominant cost** (+~7.7 KB vs 803 KB baseline: VisionInspector). The 700 KB target was already exceeded at baseline. |
| `dist/assets/vision.worker-*.js` | 6,815 (6.8 KB) | vision worker shell — lazy, spun up by the panel |
| `dist/assets/transformers.web-*.js` | 899,013 (878 KB) | transformers.js runtime — lazy-loaded inside the worker only, never in panel.js |
| `dist/assets/panel-*.css` | 44,056 (43 KB) | |
| `dist/assets/ort-wasm-simd-threaded.jsep-*.wasm` | 21,596 KB | onnxruntime WebGPU/JSEP wasm (in vision runtime, lazy) |
| `dist/js/content.js` | 25,907 (25 KB) | content script (IIFE, classic) — verified unchanged |
| `dist/js/background.js` | 11,455 (11 KB) | MV3 service worker — verified unchanged |
| `dist/js/pages-*.js` | 1,020 | |
| `dist/models/yolos-tiny/**` | ~9.66 MB (9.2 MB) | quantized ONNX + configs, served offline via publicDir |
| `dist/wasm/ort-wasm-simd-{threaded.jsep,threaded}.wasm` | ~32 MB | offline copy used by wasmPaths override (in addition to the bundled asset above) |
| **Total `dist/`** | **~63 MB** | dominated by offline model + runtime wasm; JS-only ≈ ~1.75 MB |
| JS total (panel+worker+chunks, excl. offline assets) | ~1.75 MB | |

Chrome-focus: the **service worker (11 KB)** and **content.js (25 KB)** are already "light-weight".
The **panel.js 829 KB (baseline 803 KB)** is the resource story to defend under SIH metric #4; the
vision model + runtime stay OUT of it via the module-worker split.

### Vision-specific MEASURED results (Phase 1)
- **AT-01 real offline inference**: model loaded from local bundled files only (`local_files_only`,
  `allowRemoteModels=false`); sample fixtare → 2 cats, image-relative boxes, measured on CPU
  (onnxruntime-node): preprocess ≈ 49–51 ms, inference ≈ 1037–1062 ms, postprocess ≈ 1 ms, total ≈
  ~1.1 s. Label map verified byte-exact against the shipped `config.json`.
- In-browser WebGPU/WASM latency and memory: **NOT MEASURED** (no browser/Playwright harness here);
  code path is identical to the measured node path.

### Baseline test suite — MEASURED (Phase 1)
- Extension: **44 files / 502 tests passed** in ~23 s (vitest), incl. 21 new vision tests + AT-01.
  `npm run typecheck` exit 0. `npm run build` (panel + content + verify-content-build) exit 0.
- Backend: 100 passed in 2.34 s (pytest in `backend/.venv`) — unchanged by Phase 1.

---

## 3. Memory metrics — NOT MEASURED (instrumentation required)

| Metric | Value | Instrumentation |
|---|---|---|
| Idle extension memory | NOT MEASURED | Chrome task manager / `measureUserAgentSpecificMemory` |
| Panel-open memory | NOT MEASURED | as above |
| Active-agent memory | NOT MEASURED | as above |
| Peak during vision | NOT MEASURED (vision absent) | harness marks around inference |
| Peak during automation | NOT MEASURED | harness around action bursts |
| Memory after task | NOT MEASURED | measure post last-step, then idle |

Required: a `tools/metrics/` harness (Phase 1) that records `performance.memory`, counts active
workers, and samples before/after each pipeline stage.

---

## 4. Startup latency — MEASURED (bundle-level proxy) / NOT MEASURED (runtime)

- Extension init: NOT MEASURED (requires loaded-extension timing).
- Panel init (first usable UI): ESTIMATED from bundle — parse of 803 KB panel.js dominates; expect ~100–600 ms on mid hardware. **Verify in Phase 1 harness.**
- Agent initialization: NOT MEASURED (browser runtime).
- Model initialization: N/A today (no model). Budget set in §7.

---

## 5. Agent latency breakdown — ESTIMATED (existing loop) + NOT MEASURED (runtime)

Pipeline (from `controller.ts`): user command → plan → LLM/API → action → browser interaction → verify → response.

| Stage | Status | Evidence |
|---|---|---|
| Intent/planning (deterministic) | MEASURED via unit tests (planner completes instantly, sub-ms CPU) | `deterministic-planner.ts` |
| LLM/API request | NOT MEASURED (external; Groq/Gemini/OpenRouter) | gateway in `services/ai/*` |
| Action execution | NOT MEASURED (browser) | executor in `content/executor.ts` |
| Vision processing | **ABSENT** — no code path | grep vision |
| Total E2E | NOT MEASURED | Harness required |

**Latency is the risk item: the PS gives it 15% of the score and today there is zero runtime evidence.**

---

## 6. Vision latency — NOT MEASURED (no vision pipeline; budget defined)

Defined in MODEL-DECISION.md §8 and §9 budgets below.

---

## 7. Hardware / browser test environment (baseline reference)

| Item | Value |
|---|---|
| Host | macOS (darwin), node v26.0.0 |
| Browser for future runtime benchmarks | Chrome stable (latest) primary, Firefox stable parity |
| Hardware | to be recorded at each benchmark run (device must be noted; SIH finals hardware varies) |
| Network | local backend loopback for tests; internet for providers |
| Measurement tool | vitest (unit/perf in node), Playwright/Puppeteer (browser runtime), DevTools (memory) |

---

## 8. Target budgets (rationale anchored to PS 25/20/20/20/15)

| Metric | Target | Warning | Critical | Method |
|---|---|---|---|---|
| Service worker bundle | ≤ 40 KB | > 60 KB | > 150 KB | bundle-size CI |
| content.js bundle | ≤ 60 KB | > 90 KB | > 200 KB | bundle-size CI |
| panel.js bundle | ≤ 700 KB | > 900 KB | > 1.2 MB | bundle-size CI |
| Vision worker chunk (models+runtime) | ≤ 12 MB | > 16 MB | > 24 MB | bundle-size CI |
| Model load (from cache/local) | ≤ 800 ms | > 1.5 s | > 3 s | harness |
| Frame capture→tensor | ≤ 50 ms | > 100 ms | > 250 ms | harness |
| Vision inference (WebGPU, ≤ 640 px) | ≤ 150 ms | > 300 ms | > 800 ms | harness |
| Vision inference (WASM/CPU fallback) | ≤ 900 ms | > 1.5 s | > 3 s | harness |
| Sanitize→transmit | ≤ 150 ms | > 300 ms | > 600 ms | harness |
| E2E task step (one action, local path) | ≤ 1.5 s | > 3 s | > 6 s | E2E harness |
| E2E task step (server/LLM path) | ≤ 4 s | > 8 s | > 15 s | E2E harness |
| Idle memory | ≤ 120 MB | > 200 MB | > 350 MB | memory harness |
| Peak memory during vision | ≤ 500 MB | > 800 MB | > 1.2 GB | memory harness |
| First usable panel | ≤ 800 ms | > 1.5 s | > 3 s | startup harness |

Rationale: "light-weight browser agent" + existing panel 803 KB baseline; vision chunk budget keeps a
small detection model (≤ 8 MB quantized) + runtime (~2 MB) + glue within 12 MB lazy-loaded. E2E latency
budget keeps the demo snappy under the 15% metric while the 25% accuracy metric sets the accuracy floor —
the trade-off is explicit per PS R-10.

---

## 9. Regression methodology (CI, from Phase 7)

1. `npm run build` emits bundle sizes; a `verify-budget` script fails on Critical thresholds (SILENT failure if script absent).
2. `npm run test` runs vitest (currently 481); backend `pytest` (100).
3. A dedicated `tests/metrics/` suite (to be created) regenerates `METRICS-SPEC.md` numbers on every
   tagged run; drift past Warning blocks merge.
4. Chrome memory/latency numbers are captured by a Playwright harness producing `dist/metrics.json`.
5. Every report must record browser version, hardware, network conditions to be comparable.