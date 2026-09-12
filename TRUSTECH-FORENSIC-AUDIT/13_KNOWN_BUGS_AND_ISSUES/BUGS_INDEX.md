# Bugs Index

B1 content.js ESM-in-classic (ERROR 1) — critical, verified in dist.
B2 receiving-end-does-not-exist (ERROR 2) — consequence of B1.
B3 UI stuck connecting (ERROR 3) — CTX_PING unrouted + always-true onMessage.
B4 dock page commands unknown_command; B5 back/forward false success; B6 SW-restart no_active_tab; B7 GET_TAB/LIST_TABS unrouted; B8 sendPanelEvent no-op; B9 verifier rubber-stamp; B10 planner action gaps; B11 noop LLM.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
