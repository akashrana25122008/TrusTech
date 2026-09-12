# Content Scripts

Declared: matches http/https/localhost, js/content.js, css inject.css, run_at document_idle, no type field (classic).
The current content.js breaks its own contract (ESM import). After FIX_PLAN_1 the artifact must contain zero top-level imports/exports.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
