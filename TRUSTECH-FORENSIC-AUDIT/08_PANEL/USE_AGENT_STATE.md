# useAgentState

Manages the browserControl boot flag, mini/agent state machine, error strings, telemetry, navigation, dock/scratchpad, and the agent bot mode.
On handshake timeout it renders an explicit ERROR state rather than the old silent stuck banner.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
