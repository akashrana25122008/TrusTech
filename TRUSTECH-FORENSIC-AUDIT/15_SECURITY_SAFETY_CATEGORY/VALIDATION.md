# Validation

RPC envelope type whitelist; executor action allowlist (performAction + AGENT_INJECT_ACTION sets); capability policy gates; no arbitrary JavaScript from LLM input (the agent emits structured actions only) — this invariant must survive LLM integration.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
