# Part 16 — Advanced: Vision / Privacy / Firefox (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 109 total (parts 12/14/16 added the 13 newest: LLM≈5, smoke≈4, vision≈4, firefox≈1, privacy+3)
BROWSER TEST: **PENDING_USER** — capability-dependent checks below

## Changes
- **Privacy — bug fixed + coverage hardened** (`tests/extension/privacy.test.ts`, `detector.ts`):
  - Fixed an off-by-one in `keepLength` masking: head + padding + tail now reconstructs the EXACT raw
    length (lengths never leak), previously it produced raw+1.
  - New cases: SCANNING-but-not-blocked on ordinary PII (email/phone) with a positive score;
    `hardBlock:false` downgrades credit-card to sanitized (`[card]` appears, the PAN does not);
    keep-length mode never exposes values.
- **Vision — capability + DOM detection coverage** (`tests/extension/vision.test.ts`):
  - `detectCapabilities()` baseline: wasm present, webgpu/transformers/onnx absent → backend `wasm`.
  - Provider selection honors the `transformers` global; returns null otherwise; `ready()` never
    fakes success without the runtime; `describeViewport()` stays null (no VLM weights).
  - `detectInteractive()` classifies link/button/input/select from real DOM semantics and builds
    stable selectors (id-first, then `input[name=…]`, then positional fallback).
- **Firefox — adapter safety coverage** (`tests/extension/firefox.test.ts`):
  - `createFirefoxAdapter()` reports `runtimeName: "firefox"` and delegates to the chrome base.
  - Panel methods are no-ops (never throw) when `sidebarAction` is absent, and delivery works
    against the promise-based namespace.

## Root cause
Advanced areas were present in source but had no tests, so regressions (like the length-leak) went
undetected and no one could claim vision/Firefox supporting the audit honestly. Coverage is now in
place; heavy VLM/WebGPU/OCR paths remain feature-gated and honest (`ready() === false` until wired).

## Verified evidence
- 8 privacy tests incl. the fixed `keepLength` reconstruction.
- 5 vision tests (capabilities, selection, empty provider, non-fake ready/viewport, DOM detection).
- Firefox: missing sidebarAction is safe; `runtimeName` correct; listTabs resolves.

## Real browser test (operator)
1. Privacy: run a task on a page containing PII (a contact form) — outbound prompt text must show
   `[email]`/`[phone]`, verdict SCANNING/ALERT and **never** the raw values.
2. Vision: about:webgpu / transformers availability — panel capability report must match reality
   (no fake "GPU ready").
3. Firefox: load `dist` via `about:debugging#/runtime/this-firefox`; side panel opens from the
   toolbar; tasks run through the same browser-control paths as Chrome.

REMAINING ISSUES: WebGPU/ONNX/OCR providers are future-wired by design (seams + honest `ready()`).
NEXT PART: none — all sixteen repair parts closed.