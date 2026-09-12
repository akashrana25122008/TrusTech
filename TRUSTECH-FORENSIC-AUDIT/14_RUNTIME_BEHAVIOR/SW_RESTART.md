# SW Restart

MV3 SW can restart after ~30s idle: in-memory TabManager active-tab cache + tabStateRepository become empty → QUERY_ACTIVE_TAB returns no_active_tab, GET_TAB undefined, RELOAD/BACK etc. no-op → misreported.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
