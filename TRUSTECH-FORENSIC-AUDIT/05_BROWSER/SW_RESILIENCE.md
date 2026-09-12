# SW Resilience

Gap: on SW restart the in-memory tabMgr and tabStateRepo are empty; the router answers QUERY_ACTIVE_TAB from tabMgr.active() → no_active_tab.
Fix: resolve active tab via adapter.queryActiveTab() (always fresh); keep tabMgr for bookkeeping only (FIX_PLAN_9).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
