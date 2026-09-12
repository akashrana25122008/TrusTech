# Groq Phase 1 — Provider (backend-only)

STATUS: **COMPLETE — pytest green, STOPPING for approval before Phase 2**

## What changed (backend only; extension untouched)

- `backend/.env.example` — added `GROQ_API_KEY=` (empty) and `GROQ_MODEL=openai/gpt-oss-20b`.
- `backend/app/services/config.py` — `Settings` gains `groq_api_key` (`GROQ_API_KEY`)
  and `groq_model` (`GROQ_MODEL`, default `openai/gpt-oss-20b`); legacy `class Config`
  converted to `SettingsConfigDict` (same `TRUSTECH_` prefix behavior, deprecation
  warning gone). Model swap to 120b later = env change, no code.
- `backend/app/services/llm.py` — new `GroqLlmProvider(LLMProvider)` reusing the
  existing ABC over Groq's OpenAI-compatible endpoint via `httpx` (already a
  dependency; no new packages). Error taxonomy: `GroqConfigError` (missing key,
  fail fast), `GroqAuthError` 401/403 (no retry), `GroqRateLimitError` 429 (bounded
  retry), `GroqTimeoutError`/`GroqServerError` (bounded retry, exp. backoff),
  `GroqResponseError` (bad JSON / empty choices, no retry). `PlaceholderLLM` kept.
- `backend/app/privacy/__init__.py` — fixed stale `PII_FILTER` import (real defect:
  the backend suite could not even collect). Now re-exports `redact`.
- `backend/tests/test_llm_provider.py` (new, 10 tests) — missing key, valid request
  (asserts Bearer header + model in body), malformed JSON, empty choices, 401
  single-call, 429→200 retry success, timeout → 3 calls then `GroqTimeoutError`,
  persistent 500 → `GroqServerError`, env→settings mapping. All network I/O via
  `httpx.MockTransport` — no live calls, no key needed.

## Results

- `pytest backend/tests` → **14 passed** (4 pre-existing + 10 new).
- Pre-existing state: suite **failed collection** before this phase (PII_FILTER).
- Extension suite/build untouched (no extension files modified).
- Credential audit: `GROQ_API_KEY` appears only as env-var name in code, empty in
  `.env.example`, dummy values in tests; nothing in Dockerfiles or bundle paths.

## What failed / remains

- Nothing failed. Remaining for later phases: mount an agent endpoint (Phase 2),
  align backend action schema with extension `TargetSpec` (Phase 2), extension-side
  backend-speaking provider (Phase 2), live-key smoke test (operator, needs real key).
