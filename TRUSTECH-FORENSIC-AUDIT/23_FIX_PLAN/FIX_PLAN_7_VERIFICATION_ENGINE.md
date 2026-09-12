# Part 7 — Verification Engine

The deterministic planner must emit expectedOutcome per step; the verifier compares observed state (url/title/content/dialogs) to the expectation and returns a real ok/bad/unsure — no blind pass. Unit tests target each template.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
