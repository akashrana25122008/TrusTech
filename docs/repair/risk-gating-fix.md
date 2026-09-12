# Risk Gating Fix — Consequence-Based Policy (follow-up)

STATUS: **IMPLEMENTED + unit/typecheck/build VERIFIED**
UNIT TESTS: 119 passed (was 115; +4 new risk cases)
BROWSER TEST: **PENDING_USER** — live proof runbook at bottom

## Root cause fixed

`assessAction` in `extension/src/agent/risk-manager.ts` marked `navigate`,
`new_tab`, and `close_tab` HIGH unconditionally, and added a second HIGH reason
for any external URL. Every navigation-first task therefore hit `ASK_USER` at
STEP 1/5 with `"navigate" is an irreversible navigation/tab action; navigating
to external URL: …`, and the agent sat at WAITING until the user manually
approved routine browsing.

## Files changed

- `extension/src/agent/risk-manager.ts` (rewritten policy, same interface):
  - `RiskLevel` is now `LOW | MEDIUM | HIGH | CRITICAL`; `requiresConfirmation`
    is true only for HIGH/CRITICAL. Controller, bus events, and confirmation UI
    are untouched — they already key off `requiresConfirmation`.
  - Removed: the unconditional navigate/new_tab/close_tab HIGH rule and the
    external-URL-equals-risk rule.
  - LOW (autonomous): navigate, new_tab, switch_tab, reload, back, forward,
    routine clicks (search/next/open/play/…), routine typing, reads/extracts.
  - MEDIUM (advisory, never gated): submit, save/apply, downloads, add/remove
    cart, login, settings, bare book/reserve selection, close_tab.
  - HIGH (gated): financial commit (buy/pay/checkout/order/transfer), final
    booking confirmation, destructive verbs, credential-field typing, secret-like
    typed text, security-credential changes.
  - CRITICAL (gated): account deletion, permanent deletion, device/data wipe.
- `tests/extension/agent-core.test.ts` — risk matrix regression: YouTube/Google
  navigate, switch/reload/back/forward, Search click, query typing → LOW, no
  confirmation; submit/close_tab → MEDIUM, no confirmation; pay-now click,
  delete-account click, transfer-money click → HIGH/CRITICAL with confirmation.

## What was deliberately preserved

- The risk engine, confirmation UI, pause/stop, validation, and recovery paths.
- The separate `security/riskEngine` UI-demo seam and its tests (untouched).
- Credential-looks-sensitive typing still gates (existing test green).

## Verification evidence

- `npx tsc --noEmit` clean; `npx vitest run` → 119 passed; `npm run build` OK.

## Real Chrome test (operator)

1. Reload unpacked from fresh `dist/`, open YouTube.
2. Run `Search YouTube for a C language tutorial`.
3. Expected: STEP 1 navigates with NO confirmation dialog; the loop continues to
   type/search; WAITING appears only for genuinely consequential actions.
4. Negative check: drive a checkout/payment or account-deletion control and
   confirm the panel still holds for explicit approval.

## Remaining blockers

- Live-browser certification (environmental).
