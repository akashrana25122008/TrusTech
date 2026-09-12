# Sourcemap Summary

sourcemap: false in the build config; no sourcemaps in dist. Error traces point at minified bundle lines, which complicated the audit; root cause was confirmed by artifact inspection, not stack traces.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
