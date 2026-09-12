# Bot State Adapter

mapAgentToBot: AgentStatus → BotState (idle, working, thinking, success, error, unavailable) with 1:1 exhaustive coverage + a default of idle; unit-tested.
AgentBot consumes the state → motion machine (damped), aura, success halo, particles.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
