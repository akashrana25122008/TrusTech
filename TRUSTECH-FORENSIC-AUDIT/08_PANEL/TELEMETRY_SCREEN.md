# Telemetry Screen

Displays queue/dock wiring: current tab URL, status chip, telemetry toggles; updated via useAgentState (background query → state).
True push updates (page-change events) are missing until FIX_PLAN_10.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
