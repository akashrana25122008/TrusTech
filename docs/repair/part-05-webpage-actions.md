# Part 5 — Webpage Action Routing (Dock / Agent → Content) (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 78 passed (adds controller routing regression; back/forward relay)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/controller.ts` — `executeAction()` no longer forwards
  `type:"BROWSER_COMMAND"` into the content script (the content bridge only understands
  `CTX_*` and `AGENT_INJECT_ACTION`, so those commands were silently dropped). Split the
  browser-level actions by where the work lives:
  - `navigate` / `reload` / `new_tab` / `close_tab` / `switch_tab` → called directly on the
    adapter `BrowserAdapter` (tabs API), with `missing_url`-style typed errors.
  - `back` / `forward` → relayed to the content script as `AGENT_INJECT_ACTION` so
    `window.history` is the driver and verification sees the resulting page.
- `extension/src/content/main.ts` + `extension/src/shared/messages.ts` — the content script now
  acks `AGENT_INJECT_ACTION` with `{type:"AGENT_INJECT_ACTION_RESULT", payload:{ok:true}}` so a
  caller using `sendToTabAndRespond` (the agent path) gets a confirmed delivery instead of
  `undefined` → spurious failure. The dock broadcast path (fire-and-forget) is unaffected.
- Dock → SW → content path re-verified: router `AGENT_BROADCAST_TYPES` already relays
  `AGENT_INJECT_ACTION` to the active tab with URL guard + on-demand injection.
- `tests/extension/controller.test.ts` — regression asserting the content bridge never receives
  `BROWSER_COMMAND` during a full loop, `CTX_PING`/`CTX_EXECUTE` still flow, and navigation goes
  through `adapter.navigateTab`.

## Root cause (audit FINDING 4 / 8)
The dock already sent page actions correctly (`AGENT_INJECT_ACTION`), but the agent's own
browser-level actions were misrouted as `BROWSER_COMMAND` into the page, where no handler exists;
and one-shot injected actions were never acknowledged, so history commands from the agent could
not be confirmed.

## Verified evidence
- Full closed-loop task: message types seen by the bridge = `CTX_PING`, `CTX_OBSERVE`,
  `CTX_PING`, `CTX_EXECUTE`, … — no `BROWSER_COMMAND`.
- Move to `example.com` unchanged: navigate consumed by `adapter.navigateTab` only.
- `performAction("back"|"forward")` runs `window.history.back/forward()` and returns an ack.

## Real browser test (operator)
1. Dock page actions (click / type / scroll / back / forward) must visibly act on the page.
2. Agent task with a history step reports the new URL and the verifier passes, not a silent ok.
3. No `Sending message to the content script failed` / "Receiving end does not exist" in the SW console.

REMAINING ISSUES: live observation/verification loops still to be exercised against a real page (Part 6/7).
NEXT PART: 6 — Observation & grounding regression over the fixed bridge.