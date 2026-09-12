# Dist Anatomy

runtime-D5Is3KbA.js exports {o as i, r} (rawApi): the code-split runtime pulled out of content.js.
panel.js is large (699.91 kB — three.js) and loads via a script type=module tag in panel.html — valid.
background.js imports the runtime chunk — valid (SW is type module).
content.js alone is the broken artifact.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
