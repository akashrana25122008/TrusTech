# Test Environment

vitest 2.1.9 + jsdom 30; jsdom is required for DOM modules; the adapter/fakeWeb pattern keeps chrome.* out of unit tests; tsc --noEmit is the typecheck gate; build gate is icons + typecheck + vite build.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
