# Handshake (ERROR 2 / ERROR 3)

Controller: sendRpc(CTX_PING) → router → should relay to content → CTX_PONG back.
Failure chain: content dead (ERROR 1) OR CTX_PING unrouted; chrome.ts onMessage returns true unconditionally, so the response promise is left unresolved even when no meaningful response exists → UI stuck on Connecting to the browser….

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
