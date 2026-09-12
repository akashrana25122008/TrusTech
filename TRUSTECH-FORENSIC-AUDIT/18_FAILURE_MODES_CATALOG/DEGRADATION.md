# Degradation Policy

On failure: explicit ERROR state in the panel (never silent); recovery retries are bounded; unsupported pages report a clear message with content suppressed.
Current code has the intent; wiring gaps make some paths silent (B5).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
