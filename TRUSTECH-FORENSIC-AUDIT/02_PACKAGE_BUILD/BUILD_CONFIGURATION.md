# Build Configuration

Vite 5 single config (vite.config.ts): inputs panel (html), content (ts), background (ts); entries under js/{name}.js; chunks js/{name}-[hash].js; es2020 target; react plugin; @ alias → extension/src.
Build script: icons && tsc --noEmit && vite build. Vitest jsdom, includes tests/**/*.test.ts.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
