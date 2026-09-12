# Groq Phase 2 — FastAPI Gateway (`POST /api/agent/step`)

STATUS: **COMPLETE — pytest green, STOPPING for approval before Phase 3**

## What changed (backend only; extension untouched)

- `backend/app/schemas/step.py` (new) — `StepRequest {task, observation, history,
  verification}` / `StepResponse {action, model, usage, redacted}` plus
  `validate_tool_action`: known-tool allowlist mirroring the extension's
  `ALL_ACTION_NAMES`, required args per kind, `https?` URL enforcement
  (`javascript:`/`data:` rejected), `el_N` element-id format check. Shape gate
  only — DOM existence/liveness stays extension-side.
- `backend/app/api/agent_step.py` (new) — the endpoint: 503 when no key (never
  calls Groq), server-side PII redact as defense-in-depth (count returned),
  prompt built from task + history + verification + sanitized observation,
  fence-tolerant JSON extraction, 502 on unusable model output, 422 on bad
  bodies via FastAPI validation, auth failures → 502 with no key material.
  Provider seam (`_provider()`) is monkeypatchable; `last_usage` surfaced as
  telemetry.
- `backend/app/services/llm.py` — provider records `last_usage` from Groq
  response blocks.
- `backend/app/main.py` — mounts the agent router and the (stub) tasks router.
- `backend/tests/test_agent_step.py` (new, 10 tests) — happy path incl. usage
  passthrough, fenced bare-action acceptance, unknown-action/malformed/unsafe-URL/
  invented-id → 502, missing key → 503 without touching Groq, auth → 502 with no
  key leak, timeout → 503, bad body → 422, PII redacted pre-reasoning with count.

## Results

- `pytest backend/tests` → **24 passed** (14 Phase-1 + 10 new).
- Extension suite/build untouched (no extension files modified).

## What failed / remains

- Nothing failed. Remains: shared tool-call authoring (Phase 3 = prompt/tool
  discipline, largely present in `SYSTEM_PROMPT` + extension `prompt-builder`),
  extension-side backend-speaking provider + transport (the `LlmProvider` that
  calls this endpoint), loop wiring, and a live-key smoke test (operator).
