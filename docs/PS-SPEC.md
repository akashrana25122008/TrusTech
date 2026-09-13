# PS-SPEC — SIH26171 Requirement Specification (FROZEN)

> Phase 0 deliverable. Authoritative interpretation of the SIH26171 problem statement.
> Every requirement below is fed by the unmodified PS text (source: SIH 2026 Problem
> Statements, PS ID SIH26171). Statuses: CONFIRMED / PARTIALLY IMPLEMENTED / MISSING / UNKNOWN
> (per the actual `/Users/m4/TrusTech` codebase, commit `3de7562` + working tree).

---

## 1. SIH26171 requirement interpretation

### 1.1 Raw PS (verbatim backbone)

> **SIH26171 — On-device Visual Perception for Light-weight Browser Agents**
> - Any open-source data can be used. Use cases for evaluation will be provided during finale.
> - Background: agentic AI pipelines are server-side, which limits what sensitive data a user can share.
>   A *local agent deployed in the browser* can eliminate sharing sensitive data with the server.
>   Local systems have fewer resources, so only *non-sensitive structure* (screen layout, fields) may go to the server.
>   WebGPU, WebAssembly, ONNX Runtime Web, Transformers.js unlock lightweight client-side ML.
> - Description: build a **privacy-preserving vision agent that runs in the browser**:
>   1. a local ViT (or equivalent) reads the user's screen and takes decisions;
>   2. if visual context must go to the server, **sanitize PII/sensitive data first** (DOM tags or other methods);
>   3. **dynamically detect and redact sensitive elements** — blur faces, black out passwords, mask PII;
>   4. only anonymized, unidentifiable data is transmitted;
>   5. the central server is **aware of the redaction scheme**, processes sanitized context,
>      returns **actionable commands** (e.g. "click submit", "scroll down");
>   6. balance **inference latency vs accuracy**; demonstrate **an end-to-end task**.
> - Expected solution — client-side extension (Chrome + Firefox):
>   * Local Vision Processing (WebGPU etc.) evaluating the current screen state.
>   * Privacy Preserving Filter (bounding-box redaction, semantic obfuscation, masking), clearly demonstrated.
>   * Server-side integration: sanitized visual context → central LLM/VLM → processable data or UI action for local client.
>   * Open-source/open-weights server models allowed; cloud-hosted allowed during SIH.
> - **Evaluation metrics:** (1) accuracy of visual context from screen — 25%; (2) recall/precision of sensitive/PII detection — 20%;
>   (3) precision of redaction — 20%; (4) client-side resource utilization — 20%; (5) overall end-to-end latency — 15%.

### 1.2 Engineering interpretation

The PS is a **privacy-first, client-heavy architecture** with a *hybrid* AI topology:

- **LOCAL (mandatory):** screen capture, screen understanding (vision inference), PII/sensitive-datum detection,
  redaction, and sanitized-context assembly.
- **REMOTE (conditional):** only what cannot run locally — the LLM/VLM reasoning step — and *only after* sanitization.
- The "local reads the screen" clause is **not optional**: local vision processing and a demonstrated privacy-preserving
  filter are explicit deliverables. A DOM-text-only agent does **not** satisfy the PS.
- The 5-way scoring means none of (vision accuracy, PII detection quality, redaction precision, client resources,
  latency) can be sacrificed on paper; the solution needs *measured* evidence for all five.

---

## 2. Requirement traceability matrix

Legend: source = explicit PS text. Priority: M = Mandatory, O = Optional.
Status: CONFIRMED (in code) / PARTIAL / MISSING / UNKNOWN.

| Req ID | PS source | Engineering interpretation | Priority | Current status | Existing implementation | Missing work | Acceptance test | Measurement | Evidence refs |
|---|---|---|---|---|---|---|---|---|---|
| R-01 | "privacy-preserving vision agent which runs on browser" | A browser-extension agent whose core loop is vision-fed. | M | **PARTIAL** — agent runs in browser, but **no vision feed**. | `AgentController` loop (`extension/src/agent/controller.ts`), DOM observe via `content/observer.ts`, `content/dom-reader.ts` | Vision observation source wired into the loop | AT-01, AT-06 | vision-feed %; latency | `controller.ts:291`, `content/observer.ts` |
| R-02 | "local Vision Transformer (ViT) or equivalent reads the user's screen" | On-device inference that converts screen pixels → structured understanding (elements/boxes/classes). | M | **MISSING** — no vision runtime, no model, no inference path. | — | Add `extension/src/vision/` (capture→tensor→model→structs); ONNX Runtime Web or Transformers.js. | AT-01 | detection accuracy (25% metric) | grep vision → only `privacy/fusion.ts:304,314` provenance comments |
| R-03 | "WebGPU ... WebAssembly ... ONNX Runtime Web ... Transformers.js" | Client-side inference on WebGPU with WASM/CPU fallback. | M | **MISSING** — no deps, no capability detection. | — | capability detect + runtime wrapper + fallback chain | AT-02 | load/infer latency, MHz | `package.json` deps = react, react-dom, lucide-react, three only |
| R-04 | "Light-weight" | Resource discipline: small bundles, worker offload, quantization. | M | **PARTIAL** — content/background lean (25K/11K), but panel 803K. | build splits (`vite.config.ts`, `vite.content.config.ts`) | vision worker chunk; keep SW small; lazy panel deps | AT-03, AT-09 | bundle bytes, memory | `dist/js/*`, `dist/` 928 KB |
| R-05 | "sanitize the sensitive/PII data using DOM tags or any other method, before any network request" | Text + DOM-label sanitization before egress. | M | **PARTIAL** — DOM/text sanitizer exists; **no visual sanitization**. | `privacy/transmission.ts` (rebuild→re-scan→verdict), `privacy/detector.ts`, `privacy/india.ts` | visual-region sanitization (blur/mask/blackout) driven by vision | AT-04 | sanitized payload bytes; redaction recall/precision | `transmission.ts:348-393` |
| R-06 | "dynamically detect and redact sensitive elements. blurring faces, blacking out passwords, masking PII" | Dynamic detection→redaction at runtime; face/password/PII classes. | M | **PARTIAL** — `image.ts` has a fail-closed gate + `blackout` painter; **no face/password/vision-driven redaction**. | `privacy/image.ts` (`RedactionBox`, `RedactionMethod="blackout"` only, "no sender exists today") | face (BlazeFace), password (DOM/vision fusion), PII boxes; blur/mask methods; real sender | AT-04, AT-05 | redaction precision (20%) | `image.ts` header, `isProbableImagePayload` |
| R-07 | "Only this anonymized, unidentifiable data should be transmitted" | Egress gate: nothing identifiable leaves. | M | **PARTIAL** — policy + gate exists, but visual path unproven (gate fails closed). | `privacy/transmission.ts` verdicts `CLEAN/SANITIZED`; `image.ts` gate | end-to-end verified sanitized visual transmission | AT-04 | outbound payload assertion | `image.ts`, `transmission.ts:393` |
| R-08 | "central server which should be aware for this redaction scheme" | Server understands redaction/obfuscation metadata. | M | **MISSING** — no redaction-manifest contract on the wire. | — | shared redaction-scheme; `POST /vision_step` with manifest | AT-07 | server returns grounded actions on sanitized input | `backend/app/api/*` |
| R-09 | "return actionable commands ... local client executes" | Server → typed UI actions → client executes. | M | **PARTIAL** — XML/typed command round-trip exists for DOM; visual-grounding response not wired. | `agent_step.py`, `schemas/step.py`, `services/tools.py` `TOOL_CATALOG`, `llm/response-parser.ts` | visual-grounding response; execution of region-referenced actions | AT-06, AT-08 | command acceptance %, task success | `services/tools.py`, `content/executor.ts` |
| R-10 | "balance trade-offs between inference latency and the accuracy" | Latency/accuracy trade-off made explicit and measured. | M | **MISSING** — no benchmark harness in repo. | — | metrics harness (bundle, memory, latency, accuracy) | AT-09 | p50/p95 latencies, accuracy | missing `tests/metrics/*` |
| R-11 | Chrome + Firefox, client-side extension | Cross-browser packaging. | M | **CONFIRMED** | `dist/manifest.json`, `dist/manifest.firefox.json`, `extension/src/browser/{chrome,firefox}.ts` | vision layer must also be cross-browser | AT-10 | load + smoke both browsers | manifests |
| R-12 | End-to-end task assisting the user demonstrated | Full working demo of a task via visual context. | M | **PARTIAL** — DOM/YouTube E2E tests exist; not vision-driven. | `tests/extension/youtube-multistep.test.ts`, `demo-check.test.ts`, `groq-path-loop.test.ts` | vision-fed demo scenario | AT-06 | demo task completes | test files |
| R-13 | Open-source/open-weights models | Viable license-compatible models. | M | **PARTIAL (server)** — GPT-oss-20b/Free tiers; **MISSING (client)** — no client model selected. | server providers `services/ai/*` | license-approved client vision model + repo manifest | — | license check | `services/config.py` |
| R-14 | "accuracy of visual context from screen – 25%" | Measurable screen-understanding accuracy. | M | **MISSING** | — | labeled screen fixture set; auto-eval | AT-11 | accuracy % on fixtures | — |
| R-15 | "recall/precision for detection of sensitive/PII data – 20%" | Measurable PII detection quality. | M | **PARTIAL** — DOM PII detectors tested; no visual PII eval | `tests/extension/pii-india.test.ts`, `privacy/india.ts` | visual (pixel) PII detection eval | AT-12 | R/P metrics | pii-india test |
| R-16 | "precision of redaction – 20%" | Measurable redaction precision. | M | **PARTIAL** — `blackout` unit-only | `image.ts` painter tests | pixel-level redaction precision eval | AT-05 | pixel-IOU metrics | image tests |
| R-17 | "client-side resource utilization – 20%" | Measured CPU/memory/bundle budget. | M | **PARTIAL** — bundle measured (see METRICS-SPEC); memory not instrumented | `dist` sizes | memory/CPU instrumentation | AT-09 | RSS, working set | — |
| R-18 | "overall end-to-end latency – 15%" | End-to-end task latency, budgeted. | M | **MISSING** | — | E2E latency harness | AT-09 | wall-clock task latency | — |
| R-19 | Open-source data OK; open-weights server OK; cloud during SIH | Demo/deployment freedom. | O | **CONFIRMED** (per PS allowance) | — | — | — | — | PS text |
| R-20 | Non-sensitive structure (layout, fields) may be sent | Server may receive non-sensitive structure. | O | **PARTIAL** — DOM context sent after sanitization | `transmission.ts` | confirm layout-vs-PII split explicit | AT-04 | payload inspection | — |

---

## 3. Mandatory vs optional requirements

### Mandatory (PS-graded — the 100%)
R-01..R-18 above minus R-19 (R-19 is an allowance, not a graded deliverable).

### Optional / not graded
- R-19 deployment allowance (cloud-hosted server models).
- OCR of arbitrary screen text (PaddleOCR-compatible) — provenance plumbing exists (`fusion.ts`) but is not required.
- Visual memory, visual trust, drift detection, completion-substance gating — existing differentiators, not PS-graded.

---

## 4. Acceptance test matrix (normative summary)

Full test cards live in `docs/METRICS-SPEC.md` §7 and in Phase-1 implementation. Highlights:

| Test | Requirement | Pass criterion (measurable) |
|---|---|---|
| AT-01 | R-02 | Vision pipeline returns non-empty structured scene (boxes+classes) for a fixed fixture screenshot within budget |
| AT-02 | R-03 | Inference succeeds on WebGPU; falls back to WASM/CPU when unavailable; capability report truthfully reflects runtime |
| AT-03 | R-04 | service-worker + content bundles stay under budget; vision chunks lazy-loaded on demand |
| AT-04 | R-05/06/07 | Outbound payload contains no PII-class pixels/text; verdict = SANITIZED; gate blocks raw capture |
| AT-05 | R-16 | Redaction precision (e.g., pixel-IOU of redacted boxes ≥ 0.9) on fixture suite |
| AT-06 | R-12 | A full task (typed by user) completes end-to-end through vision+sanitize+server+execute |
| AT-07 | R-08 | Server returns typed grounded actions given sanitized image + manifest |
| AT-08 | R-09 | Executor performs returned actions; effect verified via verifier |
| AT-09 | R-10/17/18 | Metrics harness reports bundle, memory, latency, accuracy numbers |
| AT-10 | R-11 | Loads & runs in both Chrome and Firefox |
| AT-11 | R-14 | Screen-accuracy ≥ agreed target on labeled fixtures |
| AT-12 | R-15 | PII recall/precision ≥ agreed target on labeled fixtures |

---

## 5. Non-goals (exclusions — do NOT build)

- Multi-user accounts/RBAC/cloud identity on the backend.
- Persistent storage/memory of user screenshots on the server.
- Security beyond the needs of the demo (pentest, TLS hardening beyond Caddy defaults).
- Fully autonomous "no-human-in-loop" operation on destructive actions — safety gating (existing) stays.
- Mobile, desktop-binary, or server-side (cloud-only) vision inference as the **primary** path.
- Training our own foundation model; only fine-tuning/adaptation of open weights if needed.
- Distributed inference, cluster scheduling, autoscaling beyond a simple deployable container.

## 6. Hard constraints (frozen here, detailed in MODEL-DECISION.md)

| Constraint | Value |
|---|---|
| Client vision task | Screen-region understanding for redaction: faces, password/input fields, PII text regions |
| Runtime | ONNX-family (Transformers.js v3 wraps ONNX Runtime) with WebGPU→WASM-SIMD→CPU |
| Model size | ≤ 8 MB total models (~quantized q8/f16) |
| Target input resolution | ≤ 640 px longest-edge for detection |
| Total vision worker chunk | ≤ 12 MB (models + runtime + glue) lazy-loaded |
| Licenses | Apache-2.0 / MIT preferred; AGPL avoided for bundled client assets |
| Latency budget (see METRICS-SPEC) | capture ≤ 50 ms; inference ≤ 150 ms (WebGPU); E2E sanitized round-trip ≤ 3 s p50 |

## 7. Evidence references

- PS source: `SIH_2026_Problem_Statements.xlsx` (PS ID SIH26171), extracted to `/tmp/sih26171.txt`.
- Code baseline: `/Users/m4/TrusTech` @ `3de7562` + uncommitted working tree.
- Bundle: `dist/` (see METRICS-SPEC §2). Manifests: `dist/manifest.json`, `dist/manifest.firefox.json`.
- Vue of privacy: `extension/src/privacy/{image,transmission,detector,india,scripts,fusion}.ts`.
- Agent: `extension/src/agent/{controller,deterministic-planner,safety-policy,drift,trust,completion-detector}.ts`.
- Backend: `backend/app/{main.py,api/*,services/ai/*,services/tools.py,privacy/filter.py,security/gateway_auth.py}`.
- Tests: `tests/extension/` (39 files / 481 tests), `backend/tests/` (10 files / 100 tests).