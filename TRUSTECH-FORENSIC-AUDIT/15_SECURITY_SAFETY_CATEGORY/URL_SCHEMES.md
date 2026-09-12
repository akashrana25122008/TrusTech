# URL Schemes

The classifier and URL-guarded relays restrict content paths to http/https/localhost. chrome://, about:, edge:, view-source, devtools, file:, extension: are blocked → unsupported-page flow (FIX_PLAN_3).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
