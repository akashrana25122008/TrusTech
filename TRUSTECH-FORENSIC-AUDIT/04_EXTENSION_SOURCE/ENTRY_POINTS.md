# Entry Points

background/main.ts (SW boot + listeners); content/main.ts (boot classifier, channel, listeners); panel.html → panel.tsx (React root).
Each entry strictly follows MV3 context separation.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
