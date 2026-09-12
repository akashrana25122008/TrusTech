# Operations

Build = icons + typecheck + build (two-phase after FIX_PLAN_1). Test = vitest jsdom (69). Dev loop: tsc --noEmit → vitest → build → load unpacked → manual browser script. No CI yet; recommend adding the build-artifact grep checks as a CI step.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
