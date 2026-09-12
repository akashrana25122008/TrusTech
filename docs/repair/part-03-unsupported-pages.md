# Part 3 — Unsupported Page Handling + Honest UI State (Report)

STATUS: **VERIFIED (unit + typecheck; build pending end-of-part gate)**
UNIT TESTS: 73 passed (adds mid-task unsupported-page regression)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/controller.ts` — wrapped the `run()` step loop in `try/catch`. On any
  throw inside a step (observe/execute/verify), the controller now maps a platform code from the
  error (`unsupported_page | no_active_tab | content_script_not_ready | no_extension`) via the
  existing `humanError()`, emits `TASK_FAILED`, transitions to `FAILED`, and breaks.
- Added `mapPlatformError(err)` — regex-extracts the code from an error message
  (e.g. `"observe: unsupported_page"`) and returns the same friendly message the handshake
  already used, so both entry paths report identically.
- `tests/extension/controller.test.ts` — new regression: bridge answers the handshake ping, then
  CTX_OBSERVE replies `payload.error:"unsupported_page"`; the controller must fail with reason
  `"Browser page cannot be controlled. Open a regular webpage to continue."` and end in `FAILED`
  — never left in a false `OBSERVING`/`ACTIVE`.

## Root cause (audit FINDING 3c)
Handshake failures were already mapped to a friendly `TASK_FAILED`. But a tab that becomes
unsupported mid-task made `observe()` throw a raw code string that escaped the loop, so the UI
fell back to the generic "Agent runtime failed…" path and could sit on `OBSERVING` after the page
could no longer be driven.

## Verified evidence
- `controller.run(...)` with unsupported CTX_OBSERVE → exactly one `TASK_FAILED`, reason =
  friendly message; `state.runtime === "FAILED"`; loop terminates (no hang, no false ACTIVE).
- `mapPlatformError` maps all four codes; unknown errors fall through to the raw message.

## Real browser test (operator)
1. Open a normal page, start a task (handshake passes, task runs).
2. While it runs, make the active tab unsupported (navigate it to `chrome://extensions/` or switch
   to such a tab).
3. Panel should toast the friendly message, status flips to FAILED (red), NOT stuck Observing/Active.

REMAINING ISSUES: none for Part 3.
NEXT PART: 4 — Browser control routing (back/forward honest, GET_TAB/LIST_TABS, switchTab clean).