# Navigation Manager

run() navigates to an id/url category via adapter calls; validates scheme; back/forward execute history through content injection; supports new-tab, close-tab (tabGroups cleanup), switch-tab, reload.
Zone: NavigationContext holds tabId/pages/position.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
