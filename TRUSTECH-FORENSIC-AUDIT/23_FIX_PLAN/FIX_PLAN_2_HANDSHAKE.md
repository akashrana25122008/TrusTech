# Part 2 — Handshake / Message Routing

Add CTX_PING to the router CONTENT_RPC_TYPES so the panel handshake pings the content channel and answers CTX_PONG; keep onMessage returning true ONLY when a real async responder is pending; add a regression test for the ping relay.
Verify: the panel transitions past Connecting to the browser….

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
