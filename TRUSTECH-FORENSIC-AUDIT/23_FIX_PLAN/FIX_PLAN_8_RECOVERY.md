# Part 8 — Recovery Engine

Bounded retry + fallback when the verifier says bad/unsure; recover navigation/action errors; cap attempts; surface recovery log lines to the panel.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
