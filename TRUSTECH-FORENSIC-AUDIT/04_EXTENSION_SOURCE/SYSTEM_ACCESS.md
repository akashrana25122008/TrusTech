# System Access

Chrome APIs touched: tabs.query/get/update/remove/captureVisibleTab/sendMessage/create, sidePanel, scripting (fallback), groups, alarms, runtime.onMessage.
All exercised through BrowserTabAdapter so tests inject fakes.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
