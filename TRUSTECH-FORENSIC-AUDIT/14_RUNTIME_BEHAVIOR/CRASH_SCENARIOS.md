# Crash Scenarios

content parse crash (B1); chrome://, about:, edge://, file: pages → ensure() refusal → graceful unsupported-page state (desired, mostly present); captive/net-error pages handled by the classifier; extensions pages blocked by the URL allowlist.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
