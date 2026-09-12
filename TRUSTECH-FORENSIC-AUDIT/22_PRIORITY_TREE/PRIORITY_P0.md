# Priority P0 (blockers)

P0.1 dist/js/content.js must be classic-valid (FIX_PLAN_1).
P0.2 the router must relay CTX_PING so the panel handshake resolves (FIX_PLAN_2).
P0.3 never resolve a response promise without an answer (chrome.ts regression guard).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
