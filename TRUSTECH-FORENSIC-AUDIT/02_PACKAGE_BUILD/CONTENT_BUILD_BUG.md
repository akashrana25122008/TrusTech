# Content Build Bug (ERROR 1)

dist/js/content.js line 1: import{r as m}from'./runtime-D5Is3KbA.js';
Cause: Rollup hoists the shared runtime module into a chunk when multiple inputs share code; MV3 has no type:module for content_scripts, so the browser refuses the file.
Fix: build the content entry standalone as a classic IIFE with inlineDynamicImports (see 23_FIX_PLAN/FIX_PLAN_1).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
