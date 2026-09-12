# Prompt Builder

Builds constrained action instructions from task + observed DOM snapshot (structured).
Developed but unreachable: NoopLlmProvider never invokes it and the router has no pathway from task execution to an LLM round-trip.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
