# Background Boot Flow

SW main: sidePanel open-on-action, alarms, listeners, MessageRouter(adapter).
Booting the panel does not create chrome-side channels; the router relays on demand.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
