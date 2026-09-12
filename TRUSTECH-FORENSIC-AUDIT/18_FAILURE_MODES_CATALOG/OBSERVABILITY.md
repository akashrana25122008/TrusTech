# Observability

The logConsole surfaces agent/log lines in the panel; sendPanelEvent was intended to push content/background → panel, but is a no-op today → operators cannot see the page-change feed, content readiness, or silent failures. FIX_PLAN_10 fixes the channel.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
