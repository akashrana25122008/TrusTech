# Part 5 — Webpage Action Routing

Dock click/type/scroll/select → router relays AGENT_INJECT_ACTION to the active tab after ensure() (content must be alive); respond honestly when ensure fails.
Extend the executor allowed-set to the full documented set via CTX_EXECUTE for advanced actions.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
