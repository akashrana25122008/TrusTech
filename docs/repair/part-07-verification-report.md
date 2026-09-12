# Part 7 — Verification Engine: expectedOutcome-Driven (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 84 passed (adds honest typed-value pass/fail)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/deterministic-planner.ts` — every planned action now declares its
  expectedOutcome so verification is about intent, not vibes:
  - `navigate` → `{type:"url_change", urlContains}` (reaches the intended page).
  - `press_key` Enter → `{type:"content_change"}` (results appeared).
  - `type` → `{type:"element_state"}` (the typed text actually landed).
  - Part 11 additions also carry outcomes (`select` → `elementState.selected`).
- `extension/src/shared/messages.ts` + `content/accessibility-reader.ts` — `IndexedElement` gains
  `value?: string` (current input/textarea/select value) and `<select>` reports a `selected` state,
  giving the verifier factual DOM state instead of guesswork.
- `extension/src/agent/verifier.ts` — typing is now checked against the fresh observation's
  element value (or page text fallback), returning `ok:false` with evidence when the value did not
  land; `select` verification compares the target's `selected` with the expected outcome.
- Tests: `agent-core.test.ts` gains "confirms typing by reading the input value back" and "fails
  honestly when the typed value was not applied (no rubber-stamp)".

## Root cause (audit FINDING 7)
Planner actions carried no expectedOutcome, so verifyAction fell through to the default
"page is stable" → `ok:true` for every action. The verifier never rejected a failed step, so the
recovery engine had nothing to catch. Now every deterministic action states what reality must look
like afterwards, and the verifier enforces it with evidence.

## Verified evidence
- Type into `el_001` with fresh snapshot `value:"tutorial"` → ok + "typed value … present".
- Type with fresh snapshot `value:""` → FAILED, evidence "typed value missing after action".
- URL change/navigation/content-change expectations still behave as before.

## Real browser test (operator)
1. Search task: navigate step verified by URL, type step verified by the filled input, Enter step
   verified by content change — all evidence visible in the panel log.
2. Deliberately break a step (e.g. blocked field): the panel must fail verification, show evidence,
   and let recovery act — not report success.

REMAINING ISSUES: LLM planner (Part 12) must attach outcomes too (schema already supports it).
NEXT PART: 8 — Recovery engine bounded retries.