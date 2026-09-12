# Part 10 — Panel Events: sendPanelEvent → Runtime Broadcast (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 82 passed at time of part (adds panel event subscription)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/browser/adapter.ts` + `chrome.ts` — new `broadcast(message)` on the adapter:
  `runtime.sendMessage(m, cb)` with lastError consumed (one-way event dispatch to all contexts).
- `extension/src/browser/index.ts` — no-op stub added for dev preview.
- `extension/src/background/panels.ts` — `PanelsService.broadcast(event)` forwards worker-side
  events through the adapter broadcast.
- `extension/src/background/main.ts` — `sendPanelEvent(event)` now actually broadcasts
  (`panels.broadcast(event)`). Router events (`EVENT_PAGE_CHANGED`, `EVENT_TAB_CREATED`,
  `EVENT_TAB_CLOSED`, `EVENT_TAB_SWITCHED`) finally leave the worker.
- `extension/src/browser/panel.ts` — `onMessage()` now registers a real runtime listener
  (once, multi-subscriber fan-out) so the side panel can consume the broadcasts.
- Tests: `tests/extension/panel-adapter.test.ts` — one native listener is registered and every
  subscriber receives each broadcast; adapter is inert when no extension API exists.

## Root cause (audit FINDING 8)
The worker built the full `sendPanelEvent` pipeline into the router but the final hop was a
literal `return;` — nothing ever reached the panel, so the side panel never saw tab launches,
closures, switches, or page mutations in real time.

## Verified evidence
- `PanelsService.broadcast` → `adapter.broadcast` → runtime.sendMessage (typechecked, builds).
- Panel adapter: broadcast event `{type:"EVENT_TAB_CREATED"}` reaches two subscribers; one native
  addListener for the whole adapter.

## Real browser test (operator)
1. Panels Development console → add `chrome.runtime.onMessage.addListener(console.log)`.
2. Dock → New tab / Close tab / Switch tab and make a page mutation: the panel console must print
   `EVENT_TAB_CREATED` / `EVENT_TAB_CLOSED` / `EVENT_TAB_SWITCHED` / `EVENT_PAGE_CHANGED`.
3. Confirm no `Unchecked runtime.lastError` from the worker.

REMAINING ISSUES: panel UI doesn't subscribe its event-driven UI yet (out of per-part scope; hook
is ready on PanelTransportAdapter.onMessage).
NEXT PART: 11 — Task behaviors (choose / select / date).