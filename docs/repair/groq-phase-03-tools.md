# Groq Phase 3 — Structured Tool Calling

STATUS: **COMPLETE — pytest green, STOPPING for approval before Phase 4**

## Finding: one real divergence, fixed

The backend tool set contained `"observe"`, which the extension validator rejects
(`observe` is automatic in the loop, not a model action). The gateway would have
accepted and forwarded actions the extension could never execute. Removed.

Also noted (not changed — implementation wins): the task brief's example outcome
values (`page_change`, `url_contains`/`value`) do not match the real
`ExpectedOutcome` schema; the catalog uses the real vocabulary (`url_change` +
`urlContains`, `content_change`, `element_state`, `navigation`, `tab_switch`,
`noop`).

## What changed (backend only; extension untouched)

- `backend/app/services/tools.py` (new) — `TOOL_CATALOG`: all 24 tools with
  name, description, strict args, constraints, and expected-result semantics;
  `render_tool_prompt()` renders the strict tool section of the model prompt.
  Prompt and validator share this one source — no duplication inside the backend.
- `backend/app/schemas/step.py` — `validate_tool_action` driven by catalog
  `required` lists (target/url/ms special-cased, rest must be strings).
- `backend/app/api/agent_step.py` — `SYSTEM_PROMPT` now embeds the rendered
  catalog plus `expectedOutcome` vocabulary rules and ask_user/finish discipline.
- `backend/tests/test_tools.py` (new, 4 tests) — backend tool names ==
  extension `ALL_ACTION_NAMES` parsed from the TS source (cross-boundary sync
  guard), every tool has description/args/constraints/outcome, prompt render
  covers all tools, per-kind required fields declared.

## Results

- `pytest backend/tests` → **28 passed** (24 + 4 new).
- Extension suite/build untouched.

## What failed / remains

- Nothing failed. The extension `prompt-builder.ts` keeps its compact schema for
  the (currently unwired) direct-provider path; the gateway catalog is
  authoritative for cloud reasoning. Remains: extension-side backend transport
  (the `LlmProvider` that calls this endpoint + loop wiring), live-key smoke.
