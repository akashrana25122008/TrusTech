# Part 12 — LLM Planner Integration (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 96 passed (adds LLM planner fallback + pluggable controller planner)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/llm-planner.ts` (new) — `buildLlmPlanner(provider, historyHint)` returns an
  `ActionPlanner` that:
  1. Asks the provider if it is available (`provider.available()`).
  2. Builds the firewall-sanitized prompt (`buildPrompt`) and calls `provider.complete`.
  3. Uses the first schema-validated action, or **falls back to the deterministic planner**
     whenever the provider is unavailable, returns no actions, returns unparsable output, or
     throws — the loop never stalls on a dead model.
- `extension/src/agent/controller.ts` — the controller now accepts an optional `planner` argument
  (typed `ActionPlanner`, sync or async). It stays defaulted to `planNextAction`, so every existing
  path is untouched; callers (e.g. background/panel wiring) can inject the LLM planner later
  without touching the loop.
- Tests: `tests/extension/llm-planner.test.ts` — unavailable provider → deterministic; valid LLM
  action → used; invalid output → fallback; provider throws → fallback; exhausted steps → null.
  `tests/extension/controller.test.ts` — an injected custom planner is invoked and completes.

## Root cause
`llm/` had the boundary (client, prompt builder, response parser) and the deterministic runtime
existed, but nothing glued them: the controller hard-coded `planNextAction`, so a provider
configured in a later build had no entry point. This part adds the seam and proves the fallback
semantics offline (a real provider decision remains a config/ops choice).

## Verified evidence
- `buildLlmPlanner(noop).(…)` returns the deterministic `navigate` for a search task.
- Mock provider returning `click el_002` → planner returns that click, with `LLM (mock)` in the
  justification.
- Mock provider returning garbage / throwing → deterministic result (not an exception).
- Controller with a custom planner completes a task through it (planner overrides the default).

## Real browser test (operator)
1. Wire a provider (or enable the existing hook) in `main.ts` where `new AgentController` is
   constructed; pass `buildLlmPlanner(provider)`.
2. Run a task — confirm the model's actions flow into validate/execute/verify, and unplug the
   network mid-run to confirm automatic deterministic fallback (task continues, no stall).

REMAINING ISSUES: no real provider is shipped — the seam is proven with the mock path only.
NEXT PART: 14 — real-world test suite wiring (browser-gated).