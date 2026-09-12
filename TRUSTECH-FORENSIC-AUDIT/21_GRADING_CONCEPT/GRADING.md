# Grading

Grading is capability-based: for each control cell we require (a) code path present, (b) live path verified in a real browser, (c) honest outcome reporting, (d) recovery handling. A cell only counts when (b)+(c) hold.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
