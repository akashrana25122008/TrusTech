# LLM Providers

NoopLlmProvider (active; always returns the fallback), DeterministicLlmProvider (used in tests for reproducible turns).
No network provider wired; the models/ runtime workstreams were reviewed under models/ for a later phase.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
