# Error Codes

Defined kinds: runtime lastError; CONNECTION — Could not establish connection; syntax-parse errors; unknown_command; no_active_tab; unsupported_url.
Proposed taxonomy: E1xx content, E2xx routing, E3xx agent, E4xx LLM, E5xx system.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
