# Part 4 — Browser Control Routing

Route BROWSER_COMMAND switchTab/back/forward/reload/close fully; back/forward must surface real delivery failures (stop swallowing); add GET_TAB and LIST_TABS router cases; remove the bogus navigate-to-empty-tabId.
Verify with a real tab: switch, reload, back/forward outcomes match the page.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
