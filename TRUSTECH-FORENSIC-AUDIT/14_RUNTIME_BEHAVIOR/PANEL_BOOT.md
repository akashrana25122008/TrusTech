# Panel Boot Flow

panel.html loads panel.js (module) → React → TelemetryScreen measures the active tab via GET_TAB (unrouted → undefined) → controller start → handshake (fails/hangs per above) → ERROR state rendered with the bot unavailable.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
