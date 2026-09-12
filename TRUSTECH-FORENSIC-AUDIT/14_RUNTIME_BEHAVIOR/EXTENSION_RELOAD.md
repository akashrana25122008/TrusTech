# Extension Reload

Reloading re-injects content scripts on navigation; the SW context resets (tabMgr + tabState wipe).
If the bundle were correct, content would re-boot on page load; today reload keeps failing at parse.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
