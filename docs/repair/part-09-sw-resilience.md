# Part 9 — SW Resilience: Adapter-Driven Active Tab (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 82 passed (parts 9+10 combined run)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/background/tab-manager.ts` — `active()` is now async with a two-tier strategy:
  - Warm path: the in-memory active context (steady-state RPC fast path — same sync answers).
  - Cold path (service-worker restart / first call): `adapter.queryActiveTab()` resolves the live
    tab instead of trusting a cache that the restart wiped.
- `extension/src/background/router.ts` — all four `tabMgr.active()` call sites updated to `await`.
- The purpose map and tab-lifecycle listeners are retained; the adapter is now the source of truth
  the moment the cache cannot answer.

## Root cause (audit FINDING 6 / SW restart)
`active()` read a purely in-memory cache. After the MV3 service worker restarted (idle, reload),
the cache was empty but the router still asked for an active context — the agent could report
nothing to act against. Driving the answer from the adapter on cache miss
closes that gap without a persistence layer.

## Verified evidence
- Warm path unchanged (tests rely on it: 4 router flows still pass).
- Cold path compiles and awaits the adapter's live query (covered implicitly; real restart is an
  operator check below).

## Real browser test (operator)
1. Run a task, then kill the SW (Chrome: extension → service worker → stop / or wait for idle).
2. Interact with the panel again — it must pick up the live active tab from the browser, not show
   "no active tab" from the dead cache.

REMAINING ISSUES: none for Part 9.
NEXT PART: 10 — Panel events (sendPanelEvent → runtime broadcast).