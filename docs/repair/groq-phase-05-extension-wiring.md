# Groq Phase 5 — Extension Runtime Gateway Wiring & Verification

STATUS: **COMPLETE — all vitest/pytest/tsc/build gates green, STOPPING per instructions**

## Architecture & Implementation

Phase 5 establishes the live connection from the extension agent runtime to the FastAPI
Groq reasoning gateway:

```
┌────────────────────────────────────────────────────────┐
│ Extension Runtime (Panel / Controller)                 │
│                                                        │
│  useAgentState.ts                                      │
│    └─ AgentController                                  │
│         └─ planner = buildLlmPlanner(GatewayLlmProvider)│
│              │                                         │
│              ├─ available(): GET /health               │
│              ├─ complete(): POST /api/agent/step       │
│              └─ fallback: planNextAction (deterministic)│
└───────────────────────┬────────────────────────────────┘
                        │ HTTP JSON RPC
                        ▼
┌────────────────────────────────────────────────────────┐
│ FastAPI Backend Gateway (:8000)                        │
│                                                        │
│  agent_step.py                                         │
│    ├─ validate_tool_action                             │
│    ├─ PII redact defense-in-depth                      │
│    └─ GroqLlmProvider                                  │
│         └─ HTTPS api.groq.com (OpenAI-compatible)      │
│              (GROQ_API_KEY from backend/.env only)     │
└────────────────────────────────────────────────────────┘
```

## What changed

1. **`extension/src/llm/gateway-provider.ts`** (new)
   - Implements `LlmProvider` (`name: "groq-gateway"`).
   - `available()`: queries `GET /health` with bounded timeout; returns true only on HTTP 200 `{ status: "ok" }`.
   - `complete()`: sends `POST /api/agent/step` with `{ task, observation, history, verification }`.
   - Validates response actions using `validateAction` against the extension's authoritative schema.
   - Propagates backend HTTP errors, timeouts (`gateway_timeout`), malformed JSON, and network errors.
   - Zero secrets: never touches `GROQ_API_KEY`, never calls `api.groq.com`.

2. **`extension/src/llm/llm-client.ts`**
   - Added `StepContext` interface and optional `stepContext` to `LlmRequest`.
   - Re-exports `GatewayLlmProvider`.

3. **`extension/src/agent/llm-planner.ts`**
   - Added `PlannerContext { history, verification }`.
   - `buildLlmPlanner()` packages `PlannerContext` into `stepContext` for gateway providers.
   - If provider is unavailable or errors, falls back to `det()` (deterministic planner) without falsely reporting Groq as active.

4. **`extension/src/agent/controller.ts`**
   - Extracts `history` (executed actions summary) and `lastVerification` (latest verification evidence) from `this.memory`.
   - Passes context to `this.planner(task, stepIndex, snapshot, { history, verification })`.
   - Preserves all gates: Action Validator, Risk Engine, Confirmation, Verifier, Recovery, Pause/Resume.

5. **`extension/src/ui/hooks/useAgentState.ts`**
   - Wires `GatewayLlmProvider` and `buildLlmPlanner(gatewayProvider)` into `AgentController`.
   - Maintains single agent controller instance (no duplicate loop, no bypass).

6. **`tests/extension/gateway-llm-provider.test.ts`** (new, 10 tests)
   - Successful gateway request with full context payload.
   - Malformed gateway response handling (non-JSON, missing action, invalid schema).
   - Backend offline / network failure handling.
   - Backend 503/502 HTTP error propagation.
   - Request and health-check timeout handling.
   - Fallback to deterministic planner when backend is offline.
   - Fallback when gateway returns error.
   - Successful LLM plan and justification labeling.
   - Security assertion: zero `GROQ_API_KEY` in extension source.
   - Security assertion: zero direct `api.groq.com` references in extension source.

7. **`tests/extension/controller.test.ts`** (+1 test)
   - End-to-end task execution in closed-loop `AgentController` via `GatewayLlmProvider`.

## Results

- `npx vitest run` → **143 passed** (20 test suites, was 132).
- `PYTHONPATH=. backend/.venv/bin/pytest backend/tests` → **31 passed** (was 28).
- `npx tsc --noEmit` → **clean (0 errors)**.
- `npm run build` → **clean build (vite + icons + IIFE content check)**.
- Bundle security audit:
  - `GROQ_API_KEY`: 0 occurrences in `dist/` and `extension/`.
  - `api.groq.com`: 0 occurrences in `dist/` and `extension/`.
  - `gsk_`: 0 occurrences in `dist/` and `extension/`.

## Connection Status

**Extension → FastAPI → Groq is now connected**:
- Extension runtime directs reasoning to `POST /api/agent/step`.
- FastAPI gateway handles server-side PII filtering, reads `GROQ_API_KEY` from `backend/.env`, and dispatches to Groq.
- The extension automatically falls back to deterministic planning if the backend is stopped or unavailable.
