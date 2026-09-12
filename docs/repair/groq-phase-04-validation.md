# Groq Phase 4 — Action Validation Pipeline

STATUS: **COMPLETE — vitest/tsc/build green, STOPPING for approval before Phase 5**

## Finding: two real gaps, both fixed

1. **Risk gate was blind to labels.** The controller passed planner actions carrying
   bare `elementId`s to `assessAction`, but contextual classification keys on the
   human-visible target name — so a "Pay now" click could never gate in the live
   loop. Fixed with `resolveTargetContext` (risk-manager): enrich a COPY of the
   action with role/name from the current snapshot before assessment. The planned
   action itself is untouched.
2. **No tab-ownership check on observations.** Nothing verified a snapshot belonged
   to the working tab. Fixed at the correct layer: the background relay stamps
   `payload.tabId` (the content script cannot know its own id), and the controller
   rejects mismatches as `stale_context`, re-syncs, and re-observes once before
   believing the page. Unknown/negative ids pass (older builds).

## What changed

- `extension/src/agent/risk-manager.ts` — `resolveTargetContext()` (new, exported).
- `extension/src/agent/controller.ts` — risk gate uses the enriched copy; observe
  loop retries once after re-sync on `stale_context`.
- `extension/src/background/router.ts` — `stampReplyTab()` on relayed content
  replies (object payloads only; error envelopes untouched).
- `tests/extension/action-pipeline.test.ts` (new, 7 tests) — full Groq-output
  pipeline: valid click → LOW; invented id → dies at target; hidden element →
  dies at target; unknown action → dies at schema; prose → dies at parse;
  payment click → passes validation, gated at risk; navigate → LOW end-to-end.
- `tests/extension/controller.test.ts` (+1) — wrong-tab observation retried,
  task completes.
- `tests/extension/adapter.test.ts` (+1) — relay stamps origin tab id.

## Results

- `npx vitest run` → **130 passed** (was 121); `tsc` clean; `npm run build` OK.
- Backend suite untouched (no backend changes this phase).

## What failed / remains

- Nothing failed. Remains: risk policy itself is already consequence-based
  (prior fix); extension-side backend-speaking provider + loop wiring (later
  phase); live-key smoke (operator).
