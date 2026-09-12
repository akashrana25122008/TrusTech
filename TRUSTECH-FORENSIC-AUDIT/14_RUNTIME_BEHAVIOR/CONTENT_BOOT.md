# Content Boot Flow

match → content.js parse (FAILS) → no channel → no ready signal → no RPC → no observe/ground/execute. All downstream runtime features are off.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
