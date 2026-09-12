# Observability

The telemetry screen shows the active tab + status; footer has single key logs; no event stream.
After FIX_PLAN_10 the panel receives EVENT_CONTENT_READY + EVENT_PAGE_CHANGED and the logConsole appends lines.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
