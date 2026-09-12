# LLM Architecture

LLM seam: provider interface, factory (NoopProvider default, DeterministicProvider for tests), prompt-builder + response-parser for instruction contracting; backend/ FastAPI gateway exists as a separate process but is unconnected.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
