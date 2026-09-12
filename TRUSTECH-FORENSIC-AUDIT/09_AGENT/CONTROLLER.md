# Controller

Handles start/stop/cancel/execute/navigate; runs the planner→action pipeline; handshake via CTX_PING with timeout; BROWSER_LEVEL_ACTIONS {navigate, new-tab, close-tab, switch-tab, reload, back, forward, tab-list} run locally, everything else via CTX_EXECUTE.
On handshake failure → ERROR + Connecting to the browser… message.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
