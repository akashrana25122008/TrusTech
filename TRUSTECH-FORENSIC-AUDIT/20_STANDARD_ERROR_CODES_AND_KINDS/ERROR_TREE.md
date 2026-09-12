# Error Tree

root: dist artifact → content-dead → handshake-hang; switch-missing → unknown_command; cache-cache → no_active_tab; broadcast-noop → stateless UI; heuristic-verify → blind pass. Each maps 1:1 to a FIX_PLAN part.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
