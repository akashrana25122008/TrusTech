# Part 8 — Recovery Engine: Bounded Retries (Report)

STATUS: **VERIFIED (already implemented — regression test proves the bound)**
UNIT TESTS: covered by `agent-core.test.ts` ("bounded retries then gives up")
BROWSER TEST: **PENDING_USER** — checklist at bottom

## State
Part 8 was audited as "Recovery engine → bounded retries" ("NOT_STARTED" in the phase list). On
inspection, `extension/src/agent/recovery-manager.ts` already implements exactly the required
behavior:

- `RetryManager`-style `RecoveryManager` with `maxRetries` (default 3).
- `plan(reason)` increments the attempt counter, selects a strategy, and after exceeding `max`
  returns `{ kind: "give_up", reason }` — never an infinite retry loop.
- Strategies: `reobserve_then_retry` for stale/DOM/logging/navigation failures, generic fresh
  re-observe otherwise; `reset()` after success.
- Called from the controller on verification failure (the honest verification from Part 7 now
  feeds it real failure reasons).

## Root cause
The phase table marked the engine "not started" because no part report covered it and the
controller tie-in was loose. The mechanics exist; the gap was that Part 7's rubber-stamp ever
let a step "fail" to drive recovery — fixed in Part 7. Nothing further was needed here.

## Verified evidence
- `new RecoveryManager(2)` → two `reobserve_then_retry` then `give_up`; `exhausted === true`;
  `reset()` clears. (Existing regression test in agent-core.)

## Real browser test (operator)
1. Break a step so verification fails (e.g. a field the page blocks).
2. Confirm the panel logs bounded re-observes and, after the cap, gives up honestly with a reason
   (`give_up: exhausted N retries: …`) instead of looping forever.

REMAINING ISSUES: none for Part 8.
NEXT PART: 9 — SW resilience (adapter-driven active tab).