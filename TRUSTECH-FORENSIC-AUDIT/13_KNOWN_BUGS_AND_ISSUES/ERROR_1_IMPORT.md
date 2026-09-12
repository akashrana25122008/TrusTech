# ERROR 1 — SyntaxError in content.js

Evidence: dist/js/content.js line 1: import{r as m}from'./runtime-D5Is3KbA.js';
Chrome: Uncaught SyntaxError: Cannot use import statement outside a module (every page).
Root cause: Vite hoisted the shared runtime chunk. Fix: FIX_PLAN_1 (standalone IIFE entry).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
