# Build Artifacts

dist/: index.html (tooling stub), panel.html, extension.html, assets/panel-*.css, js/{background,content,panel,runtime-*}.js, icons/*, manifest.json + firefox copy.
Background and panel are modules (valid); content is declared classic but references a shared chunk (invalid).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
