# Indexer

Builds a DOM index (roles, buttons, inputs, links, form fields, landmarks, iframes).
Guards: visible-only via offsetParent, capture-phase collection, debounce, subtree persistence, resilience to DOM mutation during snapshot. Feeds the grounder.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
