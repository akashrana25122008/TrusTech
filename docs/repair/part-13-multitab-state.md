# Part 13 — Multi-Tab State: Context by tabId (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 90 passed (adds mid-task tab-follow regression)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/controller.ts`
  - The controller previously pinned the tab id passed at `run()` for the WHOLE task: if the user
    switched tabs mid-task, it kept observing/acting against the stale tab.
  - Now, every loop iteration starts with step 0 — `syncWorkingTab(defaultTabId)`: re-resolves the
    true active tab from the adapter (`queryActiveTab()`), follows the user onto the new tab, and
    falls back to the bootstrap id only when the adapter cannot answer.
  - The working tab (`this.workingTabId`) drives observe/execute/verify; on a change the controller
    emits a dedicated `TAB_CHANGED {tabId, previous}` event so the UI can show the switcher.
- `extension/src/shared/event-bus.ts` — new typed event `TAB_CHANGED: { tabId: number; previous: number }`.
- Tests: `tests/extension/controller.test.ts` — two live pages, tab 7 then switch to tab 8
  mid-task; asserts exactly one `TAB_CHANGED {tabId:8, previous:7}`, the query is driven on tab 8's
  page (`stateB.results === true`) and tab 7's page is never driven (`stateA.results === false`).

## Root cause
"Context by tabId" was absent: `AgentController.run(goal, activeTabId)` captured the id once.
TabManager resolved the true active tab (Part 9) but the agent never consulted it, so multi-tab
usage produced stale-target actions and mixed the observation memory of different pages.

## Verified evidence
- Regression: with two independent pages, the loop re-resolves and switches mid-task, keeping
  observations/grounding/execution tab-scoped (per-tab element ids and state can never be
  confused between pages).
- Existing tests unchanged: the fallback path (adapter has no active tab / dev preview) still
  works; all 89 prior tests pass alongside the new one.

## Real browser test (operator)
1. Start a search task on tab A; let the panel finish at least one step (e.g. typed query).
2. Switch to tab B — the panel must emit `TAB_CHANGED {tabId:8}` and drive tab B from then on
   (not tab A), with fresh observations per the new page.
3. Switch back — agent should follow again; no stale element errors from tab A's DOM.

REMAINING ISSUES: observation memory is still a flat log — a per-tab summary store is future scope
(TaskMemory keeps everything; the controller never reuses a stale snapshot for the new tab).
NEXT PART: 12 — LLM planner integration (blocked on model runtime decision), then 14 real-world
suite.