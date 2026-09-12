# Part 1 — Content Script Build Fix

Goal: dist/js/content.js is a classic script with zero top-level import/export and no runtime-chunk dependency.
Approach: split the build — main config builds panel+background (module); a second config builds the content entry alone with output.format iife + inlineDynamicImports, entryFileNames js/content.js, emptyOutDir false, copyPublicDir false. Build script: main then content.
Verify: no top-level imports/exports in dist/js/content.js; load on google.com + youtube.com with no SyntaxError.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
