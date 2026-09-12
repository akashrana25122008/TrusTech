# Connection Phases

1) page loaded → content boot (parse) 2) content → CONTENT_READY 3) panel → CTX_PING → CTX_PONG 4) paint/gesture → browser control ready.
Phase 1 is dead; phase 3 is blocked by the router whitelist.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
