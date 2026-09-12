# Part 3 — Unsupported Page Handling

chrome://, about:, edge:// etc. must produce a graceful not-supported-on-this-page state — never false OBSERVING/ACTIVE or a silent no-op. Content suppresses; the UI shows unsupported + bot unavailable; the controller clears agent state on scheme change.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
