# Part 10 — Panel Event Channel

Wire sendPanelEvent to broadcast EVENT_CONTENT_READY / EVENT_PAGE_CHANGED over runtime.sendMessage; the panel listens via runtime.onMessage and updates telemetry (url) + logConsole; the background never swallows delivery errors.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
