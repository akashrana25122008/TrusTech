# Part 0 — Baseline Snapshot

Capture pre-repair state: builds, artifact errors, git (no commits), 69 tests pass, dist content.js ESM bug, unrouted CTX_PING, disconnected panel events.
Record in docs/repair/baseline.md. Do NOT change functional code. Verify by running build + tests and writing the baseline document.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
