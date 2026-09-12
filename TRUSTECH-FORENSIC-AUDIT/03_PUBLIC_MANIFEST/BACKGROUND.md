# Background

service_worker js/background.js, type module (valid; may import chunks).
Path must stay js/background.js after the FIX_PLAN_1 build split.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
