# Unsupported-Page vs Browser-Control Fix (follow-up)

STATUS: **IMPLEMENTED + unit/typecheck/build VERIFIED**
UNIT TESTS: 121 passed (was 119; +2 new internal-page cases)
BROWSER TEST: **PENDING_USER** — live proof runbook at bottom

## Root cause fixed

`AgentController.run` treated a failed `CTX_PING` handshake as terminal, and the
background `ContentChannel.ensure` rejects browser-internal pages with
`unsupported_page`. A task started on `chrome://newtab/` therefore died before any
action, even though the tab itself accepts browser-level navigation. Page-level
control and browser-level control were conflated.

## Files changed

- `extension/src/agent/controller.ts`
  - Startup handshake: `unsupported_page` no longer aborts the task; every other
    handshake failure still fails fast with the human message.
  - Observe step is capability-aware: on `unsupported_page` it records a synthetic
    snapshot (`pageType: "unsupported"`, real tab id/URL, zero elements) instead of
    throwing, and emits `PAGE_NOT_CONTROLLABLE` once per transition.
  - A `finish` plan against an unsupported snapshot fails honestly (“this browser
    page … does not expose webpage controls…”) instead of completing vacuously;
    page-level actions on it fail validation (no elements) as before.
  - Verify step: after navigate/reload/new_tab/switch_tab the controller polls
    `waitForContentReady` (15 s) for the destination bridge (CONTENT_READY →
    CTX_PONG) instead of failing on the first cold observation; unsupported pages
    still throw immediately.
- `extension/src/shared/event-bus.ts` — new `PAGE_NOT_CONTROLLABLE { url, tabId }`
  event (informational; never terminal).
- `extension/src/ui/hooks/useAgentState.ts` — handles the event with an info log
  (“…exposes no webpage controls — navigating to the requested site…”).
- `tests/extension/controller.test.ts` — `fakeNewtabWeb` + two cases:
  CASE 1/2/5 (navigate away from `chrome://newtab/`, survive transient cold
  observations, complete the search) and CASE 4 (task needing the internal page
  fails with the honest message and never navigates).

## What was deliberately preserved

- No content-script injection into `chrome://` pages; no new permissions.
- Risk engine, verifier, planner, validation, recovery semantics untouched.
- `ContentChannel.ensure` still hard-rejects unsupported URLs for `CTX_*`.

## Verification evidence

- `npx tsc --noEmit` clean; `npx vitest run` → 121 passed; `npm run build` OK.

## Real Chrome test (operator)

1. Reload unpacked from fresh `dist/`; open `chrome://newtab/`.
2. Run `Open YouTube and search for C language tutorial`.
3. Expected: no terminal “cannot be controlled” failure; real navigation to
   YouTube; OBSERVING → search box → typed query → submitted → results → video.
4. Negative: ask the agent to click something on `chrome://extensions/` itself and
   confirm the honest limitation message.

## Remaining blockers

- Live-browser certification (environmental).
