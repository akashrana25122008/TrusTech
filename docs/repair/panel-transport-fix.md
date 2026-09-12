# Panel Browser Transport Fix (follow-up to the 0–16 repair)

STATUS: **IMPLEMENTED + unit/typecheck/build VERIFIED**
UNIT TESTS: 115 passed (was 109; +6 new)
BROWSER TEST: **PENDING_USER** — live Chrome runbook at bottom (not claimable from here)

## Root cause fixed

The live `AgentController` drives the panel through `PanelTransportAdapter`
(`extension/src/browser/panel.ts`), whose browser-control methods were no-op stubs
(`navigateTab = nothing`, `goBackTab = nothingTrue`, …). The controller therefore
returned `ok:true` for navigation without any browser effect; the verifier correctly
failed the step and recovery exhausted into `TASK_FAILED` at STEP 1/5. Mocks in unit
tests implemented the full adapter, which is why the suite stayed green.

## Files changed

- `extension/src/browser/panel.ts` — real panel → background RPCs:
  `navigateTab`, `reloadTab`, `reloadActiveTab`, `closeTab`, `closeActiveTab`,
  `activateTab` (via `switchTab`), `goBackTab`, `goForwardTab` (via `back`/`forward`).
  Background `{ok:false}` or transport `__error` now rejects/returns false — never a
  false success.
- `extension/src/background/router.ts` — `BROWSER_COMMAND` honors an explicit
  `payload.tabId` (checked against `adapter.getTab`, stale ids → `no_such_tab`),
  falls back to the adapter-driven active tab otherwise, and always answers exactly
  once (responded-guard + try/catch, so the panel RPC can never hang).
- `extension/src/shared/messages.ts` — `BrowserCommandMessageV2Payload` now reflects
  reality: `newTab | newWindow | switchTab | closeTab | reload | back | forward |
  navigate`, optional `tabId`, optional `url`. Same message type, no parallel protocol.
- `extension/src/agent/controller.ts` — back/forward now use the delivery-checked
  `adapter.goBackTab/goForwardTab` (the old fire-and-forget `AGENT_INJECT_ACTION`
  broadcast always answered `ok:true`); browser-level adapter rejections convert to
  `{ok:false}` action failures so recovery (not an instant abort) handles them.
- `tests/extension/panel-adapter.test.ts` — panel transport sends the exact
  `BROWSER_COMMAND` payloads, rejects on background failure, and returns real
  back/forward verdicts.
- `tests/extension/adapter.test.ts` — explicit-tabId navigate routes to that tab;
  stale tabId reports `no_such_tab`.

## Messages added/reused

Reused only: `BROWSER_COMMAND` (+ existing `QUERY_ACTIVE_TAB`/`LIST_TABS`/`GET_TAB`
paths untouched). Payload gains optional `tabId`; no new message type, router, or
navigation system was created. `TabManager` stays a cache: explicit ids are verified
via `adapter.getTab`, and the active-tab cold path is unchanged.

## Verification evidence

- `npx tsc --noEmit` clean.
- `npx vitest run` → 18 files, **115 passed**.
- `npm run build` OK; `verify-content-build` OK (content.js self-contained classic IIFE).

## Real Chrome test (operator — REQUIRED before “fixed”)

1. `chrome://extensions` → reload the unpacked extension from the fresh `dist/`.
2. Open `https://www.google.com`, open the side panel.
3. Run `Search YouTube for C language tutorial`.
4. Expected: STEP 1 navigates for real (`chrome.tabs.update` via background), the
   verifier logs URL evidence, and the agent proceeds to STEP 2.
5. Individually confirm new tab / close tab / switch tab / navigate / reload /
   back / forward produce real browser effects, then click/type/scroll on the
   navigated page.

## Remaining blockers

- Live-browser certification (environmental — cannot be performed here).
- Optional: a real LLM provider behind the Part-12 seam (unrelated to this failure).
