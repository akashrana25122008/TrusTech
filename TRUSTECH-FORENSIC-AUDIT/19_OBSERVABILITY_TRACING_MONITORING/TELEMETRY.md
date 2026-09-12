# Telemetry

Current: boot flag, browserControl flag, status chip, tabs. Desired: event counters (PAGE_CHANGED/sec), handshake latency, turn counts, per-action outcomes. Metrics computed from the event channel once wired.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
