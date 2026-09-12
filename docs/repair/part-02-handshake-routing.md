# Part 2 — Handshake / Message Routing (Report)

STATUS: **VERIFIED (unit + typecheck; build pending end-of-part gate)**
UNIT TESTS: 72 passed (adds CTX_PING relay; hardens unknown-type answer)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/background/router.ts` — added `CTX_PING` to `CONTENT_RPC_TYPES` whitelist
  so panel handshake pings are relayed to the content channel and answered with `CTX_PONG`.
- `router.ts` — unclaimed messages now also reply `{ ok:false, error:"unhandled_message" }`
  before returning `false`, so a sender's response promise is never left open.
- `extension/src/browser/chrome.ts` — document why `onMessage` returns `true` (all replies are
  async; the router now guarantees an answer for every message, so no hang).
- `tests/extension/adapter.test.ts` — new CTX_PING→CTX_PONG relay assertion; extended the
  unknown-type test to assert the guaranteed answer.

## Root cause (ERROR 3 / ERROR 2 secondary)
The router whitelist `{CTX_OBSERVE, CTX_GROUND, CTX_EXECUTE}` omitted CTX_PING, so the panel
handshake RPC died in the background. Combined with the always-true keepalive (correct for async
replies but dangerous when no one ever answers), the handshake promise never resolved → UI stuck
on "Connecting to the browser…". Content script being dead (ERROR 1) produced the secondary
"Receiving end does not exist." — resolved by Part 1's artifact fix.

## Verified evidence
- `router.handle({type:"CTX_PING"})` → single response `{type:"CTX_PONG",payload:{ok:true,url}}`.
- Unknown type → `handle` returns `false` AND the caller is answered `unhandled_message`.
- Controller handshake (`controller.ts:255-271`) reads `reply.error ?? reply.payload.error` —
  CTX_PONG has none → `{ok:true}`.

## Real browser test (operator)
1. Load dist unpacked; open a normal page (e.g. example.com). Open the panel.
2. Expect handshake to complete: panel leaves "Connecting to the browser…" and shows READY/
   THINKING within a second; background SW logs no "Could not establish connection".
3. Chrome DevTools → Console on the page: no SyntaxError, no "Receiving end" error in the panel.

REMAINING ISSUES: none for the relay. (Active-tab source still cached — Part 9.)
NEXT PART: 3 — Unsupported page handling + honest UI state.