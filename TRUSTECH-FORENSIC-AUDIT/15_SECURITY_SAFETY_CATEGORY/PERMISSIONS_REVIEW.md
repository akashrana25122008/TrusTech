# Permissions Review

Scoped host_permissions http/https/localhost; tabs for metadata; activeTab temporary; scripting fallback; no all_urls; no background fetch to third parties by default. Low attack surface.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
