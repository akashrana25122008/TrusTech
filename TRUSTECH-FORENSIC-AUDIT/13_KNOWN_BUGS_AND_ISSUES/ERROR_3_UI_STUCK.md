# ERROR 3 — UI stuck on Connecting to the browser…

Evidence: controller.handshake awaits sendRpc(CTX_PING); the router whitelist lacks CTX_PING so the RPC dies in the background; chrome.ts onMessage returns true → the sender response promise is never resolved → UI stays connecting (now with an explicit ERROR state after timeout).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
