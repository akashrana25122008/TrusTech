# Part 9 — Active Tab / SW Resilience

Resolve the active tab via adapter.queryActiveTab() (fresh from the browser) instead of the in-memory cache in router active-tab paths; keep tabMgr for bookkeeping/events; after a SW restart the next message follows the current tab.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
