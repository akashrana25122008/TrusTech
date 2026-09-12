# Part 4 — Browser Control Routing (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 77 passed (adds router browser-control cases + honest back/forward)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/background/router.ts`
  - `switchTab`: removed the bogus `await this.nav.navigate(active?.tabId ?? -1, "")` — tab
    switching now only activates the target tab. Punching `navigate(id=-1, "")` into the tab API
    was a latent no-op-with-side-effect waiting to throw on a closed tab.
  - Added `LIST_TABS` case → `adapter.listTabs()` reply (panel side panel already calls it).
  - Added `GET_TAB` case → `adapter.getTab(tabId)` (falls back to the active tab when no id given).
  - Added `newWindow` case so `win.openWindow()` is reachable (panel `createWindow` seam).
- `extension/src/background/navigation-manager.ts` — new `runBool()`: `back()` / `forward()`
  resolve `{ok:false,error:"content_script_not_ready"}` when the content bridge reports the
  command was not delivered, instead of the old silent `{ok:true}`.
- `extension/src/browser/adapter.ts` — `goBackTab`/`goForwardTab` return `Promise<boolean>`
  (true only if a live content script confirmed the command).
- `extension/src/browser/chrome.ts` — history commands now use `deliverChecked()` (send, inject
  content script on miss, re-send) and report the delivery result; extracted the same helper for
  `sendToTabEnsured`. Returns `false` on unsupported pages / dead bridges.
- `extension/src/browser/index.ts` + `panel.ts` — stub signatures updated (no-op returns `true`).
- `tests/extension/adapter.test.ts` — new cases: back/forward over a dead bridge return
  `content_script_not_ready`; switchTab activates without ever navigating; LIST_TABS/GET_TAB
  answers; newWindow creates and reports the tab.

## Root cause (audit FINDING 5 / 6)
The dock's back/forward buttons and the agent's history actions reported success even when no
content script answered (`goBackTab` used fire-and-forget `send()` that swallows failures).
Tab queries the panel explicitly sends (`GET_TAB`/`LIST_TABS`) were unclaimed → `unhandled_message`
→ empty-side-panel symptom. `switchTab` carried a `navigate(-1,"")` no-op that would throw on a
closed tab.

## Verified evidence
- `router` back/forward with `adapter.goBackTab → false` → `{ok:false,error:"content_script_not_ready"}`.
- `router` switchTab → `activateTab(9)` called, `navigateTab` never called, `{ok:true}`.
- `LIST_TABS` → tab array; `GET_TAB` → tab info; `newWindow` → `{ok:true,tabId}`.

## Real browser test (operator)
1. Panel → tabs list populates (LIST_TABS) and the active tab is highlighted (GET_TAB/QUERY_ACTIVE_TAB).
2. Back/Forward buttons on a normal page actually move history; on `chrome://` they return the
   friendly "Could not connect…" error instead of silently succeeding.
3. Opening a second window from the dock reports the new tab.

REMAINING ISSUES: active-tab source still the cached `tabMgr` (Part 9).
NEXT PART: 5 — Webpage (page-level) action routing: no BROWSER_COMMAND into the content bridge.