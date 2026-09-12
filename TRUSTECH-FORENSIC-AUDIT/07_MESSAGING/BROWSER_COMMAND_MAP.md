# Browser Command Map

The dock sends BROWSER_COMMAND {command, selector?, value?} for tab commands AND page actions.
Router handles only the 7 tab commands. Missing: click/type/scroll/select → AGENT_INJECT_ACTION to content; clear/check/uncheck/radio/hover/focus/press_key/submit/extract → CTX_EXECUTE path.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
