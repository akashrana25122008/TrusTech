# Manifest Analysis

manifest.json: MV3; permissions {tabs, activeTab, tabGroups, scripting, sidePanel, storage, alarms}; host_permissions http/https/localhost; side_panel path panel.html; background service_worker background.js type module; content_scripts matches http/https/localhost, css inject.css, js js/content.js, no type → classic. Icons 16/48/128.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
